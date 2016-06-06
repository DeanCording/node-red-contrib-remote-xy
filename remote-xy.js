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

require('buffer');

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

    var REMOTEXY_RECEIVE_INPUT_VARIABLES_RESPONSE = new Buffer([REMOTEXY_PACKAGE_START_BYTE, 6, 0, REMOTEXY_CMD_RECEIVE_INPUT_VARIABLES, 0, 0]);

    var reconnectTime = RED.settings.socketReconnectTime||10000;
    var socketTimeout = RED.settings.socketTimeout||null;
    var net = require('net');

    var connectionPool = {};

    function calculateCRC(buffer) {

        var crc = 0xFFFF;

        for (var x=0; x < buffer.length-2; x++) {
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

        var configEnd = n.config.indexOf(REMOTEXY_CONFIG_END_MARKER, configStart);

        if (configEnd == -1) {
            node.error("Invalid config: Config end not found.");
            return;
        }

        var configArray = n.config.slice(configStart + REMOTEXY_CONFIG_START_MARKER.length, configEnd).replace(/(\{| |\}|\=|\;|\s)/gm, "").split(",");  // Slice out configuration, strip formatting and split into values.

        // Pre-build config response message
        node.configBuffer = Buffer(configArray.length - 4 + 5);

        node.configBuffer.writeInt8(REMOTEXY_PACKAGE_START_BYTE,0);
        node.configBuffer.writeInt16LE(node.configBuffer.length,1);
        node.configBuffer.writeInt8(REMOTEXY_CMD_SEND_CONFIG,3);

        for (var x=4; x < configArray.length; x++) {
            node.configBuffer.writeInt8(configArray[x], x);
        }

        node.configBuffer.writeUInt16LE(calculateCRC(node.configBuffer), node.configBuffer.length - 2);

        // Calc CRC for receive input variables response buffer
        REMOTEXY_RECEIVE_INPUT_VARIABLES_RESPONSE.writeUInt16LE(calculateCRC(REMOTEXY_RECEIVE_INPUT_VARIABLES_RESPONSE),
                                    REMOTEXY_RECEIVE_INPUT_VARIABLES_RESPONSE.length - 2);


        // Create input and output variables store
        var inputStart = n.config.indexOf(REMOTEXY_INPUTS_MARKER);
        var outputStart = n.config.indexOf(REMOTEXY_OUTPUTS_MARKER);
        var variablesEnd = n.config.indexOf(REMOTEXY_VARIABLES_END_MARKER);

        if ((inputStart == -1) && (outputStart == -1) && (variablesEnd == -1)) {
            node.error("Invalid config: Variables not found.");
            return;
        }

        // Extract input variables
        node.inputVariableListeners = [];
        node.inputVariableNames = [];
        node.inputVariablesBuffer = Buffer(parseInt(configArray[0]));
        node.inputVariablesBuffer.fill(0);

	if (inputStart > 0) {
            var inputConfig = n.config.slice(inputStart + REMOTEXY_INPUTS_MARKER.length, outputStart).split("\n");

            for (var x = 0; x < inputConfig.length; x++) {
                var input = inputConfig[x].match(/(?:unsigned|signed) char (\w+);/);

                if (input != null) {
                    node.inputVariableListeners.push({});
                    node.inputVariableNames.push(input[1]);
                }
            }
        }

        // Extract output variables
        node.outputVariables = [];
        node.outputVariableNames = [];
        node.outputVariablesBuffer = Buffer(parseInt(configArray[1]));
        node.outputVariablesBuffer.fill(0);
        if (outputStart > 0) {
            var outputConfig = n.config.slice(outputStart + REMOTEXY_OUTPUTS_MARKER.length, variablesEnd).split("\n");

            for (var x = 0; x < outputConfig.length; x++) {
                var output = outputConfig[x].match(/(?:unsigned|signed)? char (\w+)(?:\[(\d+)\])?;\s+\/\* (string|(=(-?\d+)+\.\.(\d+)))/);

                if (output != null) {
                    node.outputVariables.push({min:output[3]*1, max:output[4]*1, length:output[2]*1, value:0});
                    node.outputVariableNames.push(output[1]);
                }
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
            node.log("Client connected");

            var command = [];

            socket.on('data', function(data) {
                //Process incoming packet
                 for (var byte = 0; byte < data.length; byte++) {
                    command.push(data.readUInt8(byte));
                }

                // Commands start with marker and end with a valid CRC
                if (command.length > node.inputVariablesBuffer.length + 6) {
                    command.shift();  // Buffer overflow - remove invalid start marker
                }

                // Search for start marker
                while ((command.length > 0) && (command[0] != REMOTEXY_PACKAGE_START_BYTE)) {
                    command.shift();
                }
		if (command.length < 6) {
                    return;
                }

                // Get command length
                var cmdLength = command[1] + (command[2] << 8);
                if (command.length < cmdLength) {
                    return;  // Not enough data
                }

                // Check CRC if have a valid package
                if (calculateCRC(command.slice(0,cmdLength)) != (command[cmdLength-2] + (command[cmdLength-1]<<8))) {
                    node.log("CRC failed");
                    command.shift();
                    return;  // Not valid
                }

                // Process command

                command.shift();  // Drop package start byte
                command.shift();  // Drop package length bytes
                command.shift();
                var cmd = command.shift();

                switch(cmd) {
                    case REMOTEXY_CMD_SEND_CONFIG:
                        this.write(node.configBuffer);

                        break;

                    case REMOTEXY_CMD_SEND_ALL_VARIABLES:

                        var response = Buffer.concat([new Buffer([REMOTEXY_PACKAGE_START_BYTE, 0, 0, REMOTEXY_CMD_SEND_ALL_VARIABLES]),
                                                     node.inputVariablesBuffer, node.outputVariablesBuffer,
                                                     new Buffer(2)]);

                        response.writeUInt16LE(response.length, 1);
                        response.writeUInt16LE(calculateCRC(response), response.length - 2);

			this.write(response);

                        break;

                    case REMOTEXY_CMD_RECEIVE_INPUT_VARIABLES:

                        for (var x = 0; x < node.inputVariablesBuffer.length; x++) {
                            var inputValue = command.shift();
                            if (node.inputVariablesBuffer.readUInt8(x) != inputValue){
                                node.inputVariablesBuffer.writeUInt8(inputValue,x);

                                // Convert to signed value - a hack as values are 0-100 or -100-100
                                inputValue = (inputValue < 128) ? inputValue : inputValue - 256;
                                // Call listener callbacks
                                for (var ref in node.inputVariableListeners[x]) {
                                    node.inputVariableListeners[x][ref](inputValue);
                                }
                            }
                        }

                        this.write(REMOTEXY_RECEIVE_INPUT_VARIABLES_RESPONSE);

                        break;

                    case REMOTEXY_CMD_SEND_OUTPUT_VARIABLES:

                        var response = Buffer.concat([new Buffer([REMOTEXY_PACKAGE_START_BYTE, 0, 0, REMOTEXY_CMD_SEND_OUTPUT_VARIABLES]),
                                                     node.outputVariablesBuffer,
                                                     new Buffer(2)]);

                        response.writeUInt16LE(response.length, 1);
                        response.writeUInt16LE(calculateCRC(response), response.length - 2);

			this.write(response);

                        break;

                    default:
                        node.error("Unknown command " + command);
                        return;
                }

                // Strip CRC bytes
                command.shift();
                command.shift();


            });
            socket.on('timeout', function() {
                node.log(RED._("node-red:tcpin.errors.timeout",{port:node.port}));
                socket.end();
            });
            socket.on('close', function() {
                delete connectionPool[id];
                count--;
                node.status({text:RED._("node-red:tcpin.status.connections",{count:count})});
                node.log("Client disconnected");
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
                node.error("Could not store '" + value + "' to " + node.outputVariableNames[index]);
            }
        };

        node.subscribe = function(index, callback, ref) {
            node.inputVariableListeners[index][ref] = callback;

        };

        node.unsubscribe = function(index, ref) {
            ref = ref||0;
            var sub = node.inputVariableListeners[index];
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
        var node = this;

        node.dashboardConfig = RED.nodes.getNode(this.dashboard);
        if (node.dashboardConfig) {
            node.topic = node.dashboardConfig.inputVariableNames[node.index];

            node.dashboardConfig.subscribe(this.index, function(value) {
                    var msg = {topic:node.topic, payload:value};
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
            node.dashboardConfig.update(node.index, msg.payload);
        });
    }
    RED.nodes.registerType("remote-xy out",RemoteXYOutNode);

    RED.httpAdmin.get("/inputs/:id", RED.auth.needsPermission('remotexy.read'), function(request, result) {
        var dashboard = RED.nodes.getNode(request.params.id);
        if (dashboard != null) {
            result.json(dashboard.inputVariableNames);
        } else {
            result.json([]);
        }
    });

    RED.httpAdmin.get("/outputs/:id", RED.auth.needsPermission('remotexy.read'), function(request, result) {
        var dashboard = RED.nodes.getNode(request.params.id);
        if (dashboard != null) {
            result.json(dashboard.outputVariableNames);
        } else {
            result.json([]);
        }
    });

}
