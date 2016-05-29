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
"use strict";

module.exports = function(RED) {

    const REMOTEXY_PACKAGE_START_BYTE = 85;
    const REMOTEXY_CMD_SEND_CONFIG = 0;
    const REMOTEXY_CMD_SEND_ALL_VARIABLES = 64;
    const REMOTEXY_CMD_RECEIVE_INPUT_VARIABLES = 128;
    const REMOTEXY_CMD_SEND_OUTPUT_VARIABLES = 192;

    const REMOTEXY_CONFIG_START_MARKER = 'RemoteXY_CONF[]';
    const REMOTEXY_CONFIG_END_MARKER = '};';
    const REMOTEXY_INPUTS_MARKER = '/* input variable */';
    const REMOTEXY_OUTPUTS_MARKER = '/* output variable */';
    const REMOTEXY_VARIABLES_END_MARKER = '/* other variable */';

    var REMOTEXY_RECEIVE_INPUT_VARIABLES_RESPONSE = Buffer.from([REMOTEXY_CMD_RECEIVE_INPUT_VARIABLES, 4, 0, 0]);


    var reconnectTime = RED.settings.socketReconnectTime||10000;
    var socketTimeout = RED.settings.socketTimeout||null;
    var net = require('net');

    var connectionPool = {};

    function calculateCRC(buffer) {

        var crc = 0xFFFF;

        for (var x=0; x<length-2; x++) {
            crc ^= buffer[x];

            for (var i=0; i<8; ++i) {
                if (crc & 1) crc = (crc >> 1) ^ 0xA001;
                else crc >>= 1;
            }
        }

        return crc;

    }

    function RemoteXYDashboardNode(n) {
        // Create a RED node
        RED.nodes.createNode(this,n);
        var node = this;
        var count = 0;

        // Store local copies of the node configuration (as defined in the .html)
        node.port = n.port * 1;

        var configStart = n.config.indexOf(REMOTEXY_CONFIG_START_MARKER);

        if (configStart == -1) {
            node.error("Invalid config: RemoteXY_CONF[] not found.");
            return;
        }

        var configEnd = node.config.indexOf(REMOTE_CONFIG_END_MARKER, configStart);

        if (configEnd == -1) {
            node.error("Invalid config: Config end not found.");
            return;
        }

        var configArray = node.config.slice(configStart + REMOTEXY_CONFIG_MARKER.length, configEnd).replace(/\{| |\}\=\;\n/g, "").split(",");  // Slice out configuration, strip formatting and split into values.

        // Pre-build config response message
        node.configBuffer = Buffer.alloc(configArray.length + 6);

        node.configBuffer.writeInt8(REMOTEXY_CMD_SEND_CONFIG,0);
        node.configBuffer.writeInt16LE(node.configBuffer.length,1);

        for (var x =0; x < configArray.length; x++) {
            node.configBuffer.writeInt8(configArray[x], x+2);
        }

        node.configBuffer.writeInt16LE(calculateCRC(node.configBuffer), node.configBuffer.length - 2);

        // Calc CRC for receive input variables response buffer
        REMOTEXY_INPUT_VARIABLES_RESPONSE.writeInt16LE(calculateCRC(REMOTEXY_INPUT_VARIABLES_RESPONSE),
                                                       REMOTEXY_INPUT_VARIABLES_RESPONSE.length - 2);


        // Create input and output variables store
        var inputStart = n.config.indexOf(REMOTEXY_INPUTS_MARKER);
        var outputStart = n.config.indexOf(REMOTEXY_OUTPUTS_MARKER);
        var variablesEnd = n.config.indexOf(REMOTEXY_VARIABLES_END_MARKER);

        if ((inputStart == -1) || (outputStart == -1) || (variablesEnd == -1)) {
            node.error("Invalid config: Variables not found.");
            return;
        }

        // Extract input variables
        node.inputVariables = [];
        node.inputVariablesBuffer = Buffer.alloc(node.configBuffer.readInt8(0));

        var inputConfig = n.config.slice(inputStart + REMOTEXY_INPUTS_MARKER.length, outputStart).split("\n");

        for (var x = 0; x < inputConfig.length; x++) {
            var input = inputConfig[x].match(/(?:unsigned|signed) char (\w+);/);

            if (input != null) {
                inputVariables.push({name:input[1], listeners:{}});

            }
        }

        // Extract output variables
        node.outputVariables = [];
        node.outputVariablesBuffer = Buffer.alloc(node.configBuffer.readInt8(1));

        var outputConfig = n.config.slice(outputStart + REMOTEXY_OUTPUTS_MARKER.length, variablesEnd).split("\n");

        for (var x = 0; x < outputConfig.length; x++) {
            var output = outputConfig[x].match(/(?:unsigned|signed)? char (\w+)(?:\[(\d+)\])?;\s+\/\* (string|(=(-?\d+)+\.\.(\d+)))/);

            if (output != null) {
                outputVariables.push({name:output[1], min:output[3]*1, max:output[4]*1, length:output[2]*1, value:0});
            }
        }


        // Create TCP Server

        var server = net.createServer(function(socket) {
            socket.setKeepAlive(true,120000);
            if (socketTimeout !== null) { socket.setTimeout(socketTimeout); }
            var id = (1+Math.random()*4294967295).toString(16);
            connectionPool[id] = socket;
            count++;
            node.status({text:RED._("node-red:tcpin.status.connections",{count:count})});

            var command = [];

            socket.on('data', function(data) {
                //Process incoming packet
                 for (var byte = 0; byte < data.length; byte++) {
                    command.push(data.readUInt8(byte));
                }

                // Commands start with marker and end with a valid CRC
                if (command.length > node.inputs.length + 6) {
                    command[0] = 0;  // Buffer overflow - remove invalid start marker
                }

                // Search for start marker
                while ((command.length > 0) && (command[0] != REMOTEXY_PACKAGE_START_BYTE)) {
                    command.shift();
                }

                if (command.length < 6) {
                    return;  // Not enough data
                }

                // Check CRC if have a valid package
                if (calculateCRC(command, command.length-2) != (command[command.length-2] + (command[command.length-1]<<8))) {
                    node.log("CRC failed");
                    return;  // Not valid
                }

                // Process command

                command.shift();  // Drop package start byte
                command.shift();  // Drop package length bytes
                command.shift();
                command.pop();    // Drop CRC bytes
                command.pop();

                switch(command[0]) {
                    case REMOTEXY_CMD_SEND_CONFIG:
                        this.write(node.configBuffer);

                        break;

                    case REMOTEXY_CMD_SEND_ALL_VARIABLES:

                        var response = Buffer.concat([Buffer.from([REMOTEXY_CMD_SEND_ALL_VARIABLES, 0, 0]),
                                                     node.inputVariablesBuffer, node.outputVariables.Buffer,
                                                     Buffer.alloc(2)]);

                        response.writeUInt16(response.length, 1);
                        response.writeInt16LE(calculateCRC(response), response.length - 2);


                        break;

                    case REMOTEXY_CMD_RECEIVE_INPUT_VARIABLES:

                        for (var x = 0; x < command.length; x++) {

                            if (node.inputVariables[x].value != command[x]){
                                node.inputVariables[x].value = command[x];

                                // Call listener callbacks
                                for (var ref in node.inputVariables[x].listeners) {
                                    node.inputVariables[x].listeners[ref](command[x]);
                                }
                            }
                        }

                        this.write(REMOTEXY_INPUT_VARIABLES_RESPONSE);

                        break;

                    case REMOTEXY_CMD_SEND_OUTPUT_VARIABLES:

                        var response = Buffer.concat([Buffer.from([REMOTEXY_CMD_SEND_OUTPUT_VARIABLES, 0, 0]),
                                                     node.outputVariables.Buffer,
                                                     Buffer.alloc(2)]);

                        response.writeUInt16(response.length, 1);
                        response.writeInt16LE(calculateCRC(response), response.length - 2);

                        break;

                    default:
                        node.log("Unknown command");
                        return;
                }


            });
            socket.on('timeout', function() {
                node.log(RED._("node-red:tcpin.errors.timeout",{port:node.port}));
                socket.end();
            });
            socket.on('close', function() {
                delete connectionPool[id];
                count--;
                node.status({text:RED._("node-red:tcpin.status.connections",{count:count})});
            });
            socket.on('error',function(err) {
                node.log(err);
            });
        });
        server.on('error', function(err) {
            if (err) {
                node.error(RED._("node-red:tcpin.errors.cannot-listen",{port:node.port,error:err.toString()}));
            }
        });

        server.listen(node.port, function(err) {
            if (err) {
                node.error(RED._("node-red:tcpin.errors.cannot-listen",{port:node.port,error:err.toString()}));
            } else {
                node.log(RED._("node-red:tcpin.status.listening-port",{port:node.port}));
                node.on('close', function() {
                    for (var c in connectionPool) {
                        if (connectionPool.hasOwnProperty(c)) {
                            connectionPool[c].end();
                            connectionPool[c].unref();
                        }
                    }
                    node.closing = true;
                    server.close();
                    node.log(RED._("node-red:tcpin.status.stopped-listening",{port:node.port}));
                });
            }
        });

        // Node functions

        node.update = function(index, value) {

            if ((typeof value === "number") && (node.outputVariables[index].length === undefined)) {
                node.outputVariablesBuffer.writeInt8(value,index);

            } else if (node.outputVariables[index].length != undefined) {
                var valueString = value.toString();
                node.outputVariablesBuffer.write(valueString, Math.min(valueString.length,node.outputVariables[index].length));

            } else {
                node.error("Could not store '" + value + "' to " + node.outputVariables[index].name);
            }
        };

        node.subscribe = function(index, callback, ref) {

            node.inputVariables[index].listeners[ref] = callback;

        };

        node.unsubscribe = function(index, ref) {
            ref = ref||0;
            var sub = node.inputVariables[index].listeners;
            if (sub) {
                if (sub[ref]) {
                    delete sub[ref];
                }
            }
        };


    }

    RED.nodes.registerType("remote-xy-dashboard", RemoteXYDashboardNode);



    // Incoming from RemoteXY
    function RemoteXYInNode(n) {
        RED.nodes.createNode(this,n);
        this.dashboard = n.dashboard;
        this.index = n.index;
        this.topic = n.topic;
        var node = this;
        node.dashboardConfig = RED.nodes.getNode(this.dashboard);
        if (node.dashboardConfig) {
            node.dashboardConfig.subscribe(this.index, function(value) {
                    var msg = {topic:this.topic, payload:value};
                    node.send(msg);
                }, this.id);

            node.dashboardConfig.on('opened', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
            node.dashboardConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
            node.dashboardConfig.on('closed', function() { node.status({fill:"yellow",shape:"ring",text:"disconnected"}); });
        } else {
            node.error("Dashboard config missing");
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
        node.index = n.index;
        node.dashboard = n.dashboard;
        node.dashboardConfig = RED.nodes.getNode(node.dashboard);
        if (!node.dashboardConfig) {
            node.error("Dashboard config missing");
        }
        else {
            node.dashboardConfig.on('opened', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
            node.dashboardConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
            node.dashboardConfig.on('closed', function() { node.status({fill:"yellow",shape:"ring",text:"disconnected"}); });
        }
        node.on("input", function(msg) {
            node.dashboardConfig.update(this.index, msg.payload);
        });
    }
    RED.nodes.registerType("remote-xy out",RemoteXYOutNode);
}
