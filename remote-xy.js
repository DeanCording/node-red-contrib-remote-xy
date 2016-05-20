/**
 * Copyright 2016 Dean Cording
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 *  NodeRed -> out -> RemoteXY
 *  RemoteXY -> in -> NodeRed
 *
 *
 **/

module.exports = function(RED) {

    const REMOTEXY_PACKAGE_START_BYTE = 85;
    const REMOTEXY_CMD_SEND_CONFIG = 0;
    const REMOTEXY_CMD_SEND_ALL_VARIABLES = 64;
    const REMOTEXY_CMD_RECEIVE_INPUT_VARIABLES = 128;
    const REMOTEXY_CMD_SEND_OUTPUT_VARIABLES = 192;


    var reconnectTime = RED.settings.socketReconnectTime||10000;
    var socketTimeout = RED.settings.socketTimeout||null;
    var net = require('net');

    var connectionPool = {};

    function calculateCRC(buffer, length) {

        var crc = 0xFFFF;

        for (x=0; x<length; x++) {
            crc ^= buffer[x];

            for (i=0; i<8; ++i) {
                if ((crc) & 1) crc = ((crc) >> 1) ^ 0xA001;
                else crc >>= 1;
            }
        }

        return crc;

    }

    function RemoteXYDashboardNode(n) {
        // Create a RED node
        RED.nodes.createNode(this,n);
        var node = this;

        // Store local copies of the node configuration (as defined in the .html)
        node.port = n.port * 1;
        node.config = n.config.replace(/\{| |\}/g, "").split(",");  // Strip formatting


        node.inputs = new Array(node.config.shift()*1);
        node.inputs.fill(0);
        node.outputs = new Array(node.config.shift()*1);
        node.outputs.fill(0);

        node.config.shift().shift();  // Drop config length

        node.inputNodes = [];    // collection of nodes that want to receive values

        // Create TCP Server

        var server = net.createServer(function (socket) {
            socket.setKeepAlive(true,120000);
            if (socketTimeout !== null) { socket.setTimeout(socketTimeout); }
            var id = (1+Math.random()*4294967295).toString(16);
            connectionPool[id] = socket;
            count++;
            node.status({text:RED._("tcpin.status.connections",{count:count})});

            var command = [];

            socket.on('data', function (data) {


                //Process incoming packet
                var eData = data.values();
                for (let d of eData) {
                    command.push(d);
                }

                // Commands start with marker and end with a valid CRC
                if (data.length() > node.inputs.length() + 6) {
                    data[0] = 0;  // Buffer overflow - remove invalid start marker
                }

                // Search for start marker
                while ((data.length > 0) && (data[0] != REMOTEXY_PACKAGE_START_BYTE)) {
                    data.shift();
                }

                if (data.length < 6) {
                    return;  // Not enough data
                }

                // Check CRC if have a valid package
                if (calculateCRC(data, data.length-2) != (data[data.length-1] + data[data.length]<<8)) {
                    return;  // Not valid
                }

                // Process command

                data.shift();  // Drop package start byte
                data.shift();  // Drop package length bytes
                data.shift();
                data.pop();    // Drop CRC bytes
                data.pop();

                var response = [];

                switch(data[0]) {
                    case REMOTEXY_CMD_SEND_CONFIG:

                        response = Array.from(node.config);

                        break;

                    case REMOTEXY_CMD_SEND_ALL_VARIABLES:

                        response = node.inputs.concat(node.outputs);

                        break;

                    case REMOTEXY_CMD_RECEIVE_INPUT_VARIABLES:

                        node.inputs = Array.from(data);


                        break;

                    case REMOTEXY_CMD_SEND_OUTPUT_VARIABLES:

                        response = Array.from(node.outputs);


                        break;

                    default:
                        node.log("Unknown command");
                        return;
                }



                        msg = {topic:node.topic, payload:data};
                        msg._session = {type:"tcp",id:id};
                        node.send(msg);




                // Send response
                response.unshift(data[0]);

                var response_length = response.length+5;
                response.unshift(response_length>>8, response_length&0xFF, REMOTEXY_PACKAGE_START_BYTE);


                var crc = calculateCRC(response, response.length);
                response.push(crc&0xFF, crc>>8);

                this.write(response);
                command = []; // Clear command buffer

            });
            socket.on('timeout', function() {
                node.log(RED._("tcpin.errors.timeout",{port:node.port}));
                socket.end();
            });
            socket.on('close', function() {
                delete connectionPool[id];
                count--;
                node.status({text:RED._("tcpin.status.connections",{count:count})});
            });
            socket.on('error',function(err) {
                node.log(err);
            });
        });
        server.on('error', function(err) {
            if (err) {
                node.error(RED._("tcpin.errors.cannot-listen",{port:node.port,error:err.toString()}));
            }
        });

        server.listen(node.port, function(err) {
            if (err) {
                node.error(RED._("tcpin.errors.cannot-listen",{port:node.port,error:err.toString()}));
            } else {
                node.log(RED._("tcpin.status.listening-port",{port:node.port}));
                node.on('close', function() {
                    for (var c in connectionPool) {
                        if (connectionPool.hasOwnProperty(c)) {
                            connectionPool[c].end();
                            connectionPool[c].unref();
                        }
                    }
                    node.closing = true;
                    server.close();
                    node.log(RED._("tcpin.status.stopped-listening",{port:node.port}));
                });
            }
        });

        // Node functions

        node.update = function(index, value) {
            node.outputs[index] = value;

        }

        node.subscribe = function(index, callback, ref) {
            node.inputNodes[index] = node.inputNodes[index]||{};

            node.inputNodes[index][ref] = callback;

        }

        node.unsubscribe = function(index, ref) {
            ref = ref||0;
            var sub = node.inputNodes[index];
            if (sub) {
                if (sub[ref]) {
                    delete sub[ref];
                }
            }
        }


    }

    RED.nodes.registerType("remote-xy-dashboard", RemoteXYDashboardNode);



    // Incoming from RemoteXY
    function RemoteXYInNode(n) {
        RED.nodes.createNode(this,n);
        this.dashboard = n.dashboard;
        this.index = n.index;
        this.topic = n.topic;
        var node = this;
        this.dashboardConfig = RED.nodes.getNode(this.dashboard);
        if (this.dashboardConfig) {
            this.dashboardConfig.subscribe(this.index, function(value) {
                    var msg = {topic:this.topic, payload:value};
                    node.send(msg);
                }, this.id);

            this.serverConfig.on('opened', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
            this.serverConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
            this.serverConfig.on('closed', function() { node.status({fill:"yellow",shape:"ring",text:"disconnected"}); });
        } else {
            this.error("Dashboard config missing");
        }

        this.on('close', function() {
            node.dashboardConfig.unsubscribe(this.index, this.ref);
        });

    }
    RED.nodes.registerType("remote-xy in", RemoteXYInNode);

    // Outgoing to RemoteXY
    function RemoteXYOutNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.index = n.index;
        this.dashboard = n.dashboard;
        this.dashboardConfig = RED.nodes.getNode(this.dashboard);
        if (!this.dashboardConfig) {
            this.error("Dashboard config missing");
        }
        else {
            this.serverConfig.on('opened', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
            this.serverConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
            this.serverConfig.on('closed', function() { node.status({fill:"yellow",shape:"ring",text:"disconnected"}); });
        }
        this.on("input", function(msg) {
            dashboardConfig.update(this.index, msg.payload);
        });
    }
    RED.nodes.registerType("remotexy out",RemoteXYOutNode);
}
