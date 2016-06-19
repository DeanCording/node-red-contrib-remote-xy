/**
 * Copyright 2016 Dean Cording (dean@cording.id.au)
 *
 * A Node Red node for connecting to the RemoteXY dashboard Andriod app.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:

 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.

 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 *  NodeRed -> out -> RemoteXY
 *  RemoteXY -> in -> NodeRed
 *
 **/
"use strict";

require('buffer');
const util = require('util');

module.exports = function(RED) {
    const REMOTEXY_INPUT_LENGTH_INDEX = 0;
    const REMOTEXY_OUTPUT_LENGTH_INDEX = 1;
    const REMOTEXY_CONF_LENGTH_INDEX = 2;
    const REMOTEXY_CONF_INDEX = 4;


    const REMOTEXY_PACKAGE_START_BYTE = 85;   // 0x55
    const REMOTEXY_CMD_SEND_CONFIG = 0;
    const REMOTEXY_CMD_SEND_ALL_VARIABLES = 64;  // 0x40
    const REMOTEXY_CMD_RECEIVE_INPUT_VARIABLES = 128;  // 0x80
    const REMOTEXY_CMD_SEND_OUTPUT_VARIABLES = 192;  // 0xC0

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

    var inputVariableNames = {};
    var outputVariableNames = {};

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
        node.configBuffer = Buffer((configArray[REMOTEXY_CONF_LENGTH_INDEX] * 1) + 6);
        node.configBuffer.writeInt8(REMOTEXY_PACKAGE_START_BYTE,0);
        node.configBuffer.writeInt16LE(node.configBuffer.length,1);
        node.configBuffer.writeInt8(REMOTEXY_CMD_SEND_CONFIG,3);
        for (var x=4; x < configArray.length; x++) {
            node.configBuffer.writeUInt8(configArray[x], x);
        }

        node.configBuffer.writeUInt16LE(calculateCRC(node.configBuffer), node.configBuffer.length - 2);

        // Calc CRC for receive input variables response buffer
        REMOTEXY_RECEIVE_INPUT_VARIABLES_RESPONSE.writeUInt16LE(
                                    calculateCRC(REMOTEXY_RECEIVE_INPUT_VARIABLES_RESPONSE),
                                    REMOTEXY_RECEIVE_INPUT_VARIABLES_RESPONSE.length - 2);


        // Create input and output variables store
        var inputStart = n.config.indexOf(REMOTEXY_INPUTS_MARKER);
        var outputStart = n.config.indexOf(REMOTEXY_OUTPUTS_MARKER);
        var variablesEnd = n.config.indexOf(REMOTEXY_VARIABLES_END_MARKER);

        if (variablesEnd == -1) {
            node.error("Invalid config: Variables not found.");
            return;
        }

        // Extract input variables
        node.inputVariableListeners = [];
        inputVariableNames[node.id] = [];
        node.inputVariablesBuffer = Buffer(parseInt(configArray[REMOTEXY_INPUT_LENGTH_INDEX]));
        node.inputVariablesBuffer.fill(0);

	if (inputStart > 0) {
            var inputConfig = n.config.slice(inputStart + REMOTEXY_INPUTS_MARKER.length,
                               ((outputStart > 0)?outputStart:variablesEnd)).split("\n");

            for (var x = 0; x < inputConfig.length; x++) {
                var input = inputConfig[x].match(/(?:unsigned|signed) char (\w+);/);

                if (input != null) {
                    node.inputVariableListeners.push({});
                    inputVariableNames[node.id].push(input[1]);
                }
            }
        }

        // Extract output variables
        node.outputVariables = [];
        outputVariableNames[node.id] = [];
        node.outputVariablesBuffer = Buffer(parseInt(configArray[REMOTEXY_OUTPUT_LENGTH_INDEX]));
        node.outputVariablesBuffer.fill(0);
        if (outputStart > 0) {
            var outputConfig = n.config.slice(outputStart + REMOTEXY_OUTPUTS_MARKER.length, variablesEnd).split("\n");
            var index = 0;
            for (var x = 0; x < outputConfig.length; x++) {
                var output = outputConfig[x].match(/(?:unsigned|signed)? char (\w+)(?:\[(\d+)\])?;\s+\/\* (string|(=(-?\d+)+\.\.(\d+)))/);

                if (output != null) {
                    node.outputVariables.push({min:output[5]*1, max:output[6]*1, length:output[2]*1,
                    offset:index, value:0});
                    outputVariableNames[node.id].push(output[1]);
                    index += (output[2]!=undefined)?output[2]*1:1;
                }
            }
        }

        // Create TCP Server
        if (node.port > 0) {
            var server = net.createServer(function(socket) {
                socket.setKeepAlive(true,120000);
                if (socketTimeout !== null) { socket.setTimeout(socketTimeout); }
                var id = (1+Math.random()*4294967295).toString(16);
                connectionPool[id] = socket;
                count++;
                // node.status({text:RED._("node-red:tcpin.status.connections",{count:count})});
                node.log("Client connected " + socket.address().address);

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
                    if (calculateCRC(command.slice(0,cmdLength)) !=
                      (command[cmdLength-2] + (command[cmdLength-1]<<8))) {
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

                            var response = Buffer.concat([new Buffer([REMOTEXY_PACKAGE_START_BYTE,
                                                     0, 0, REMOTEXY_CMD_SEND_ALL_VARIABLES]),
                                                     node.inputVariablesBuffer,
                                                     node.outputVariablesBuffer,
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

                            var response = Buffer.concat([new Buffer([REMOTEXY_PACKAGE_START_BYTE,
                                                         0, 0, REMOTEXY_CMD_SEND_OUTPUT_VARIABLES]),
                                                         node.outputVariablesBuffer,
                                                         new Buffer(2)]);

                            response.writeUInt16LE(response.length, 1);
                            response.writeUInt16LE(calculateCRC(response), response.length - 2);

                            this.write(response);

                            // RemoteXY app polls the server continuously and needs some throttling
                            socket.pause();
                            setTimeout(function() { socket.resume();}, 100);

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
                    //node.status({text:RED._("node-red:tcpin.status.connections",{count:count})});
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
        }

        // Node functions

        node.update = function(index, value) {
            try {
                if (node.outputVariables[index].length > 0) {
                    var valueString = value.toString();
                    node.outputVariablesBuffer.write(valueString, node.outputVariables[index].offset,
                         Math.min(valueString.length,node.outputVariables[index].length)-1);
                    node.outputVariablesBuffer.writeInt8(0,
                         node.outputVariables[index].offset + Math.min(valueString.length,node.outputVariables[index].length)-1);
                } else {
                    value = parseInt(value);
                    node.outputVariablesBuffer.writeInt8(
                                               (value >= 0)?Math.min(value,255):Math.max(value,-255),
                                               node.outputVariables[index].offset);
                }
            } catch (e) {
                node.error("Could not store '" + value + "' to " + outputVariableNames[node.id][index]);
                node.error(e);
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

        node.on('close', function() {
            delete inputVariableNames[node.id];
            delete inputVariableNames[node.id + "*"];
            delete outputVariableNames[node.id];
            delete outputVariableNames[node.id + "*"];
        });


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
            node.topic = inputVariableNames[node.dashboardConfig.id][node.index];

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
            node.dashboardConfig.unsubscribe(node.index, node.id);
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

        if (inputVariableNames[request.params.id + "*"] != undefined) {
            result.json(inputVariableNames[request.params.id + "*"]);
        } else if (inputVariableNames[request.params.id] != undefined) {
            result.json(inputVariableNames[request.params.id]);
        } else {
            result.json([]);
        }
    });

    RED.httpAdmin.get("/outputs/:id", RED.auth.needsPermission('remotexy.read'), function(request, result) {

        if (outputVariableNames[request.params.id + "*"] != undefined) {
            result.json(outputVariableNames[request.params.id + "*"]);
        } else if (outputVariableNames[request.params.id] != undefined) {
            result.json(outputVariableNames[request.params.id]);
        } else {
            result.json([]);
        }
    });

    RED.httpAdmin.post("/parse/:id", RED.auth.needsPermission('remotexy.write'), function(request, result) {

        var inputStart = request.body.config.indexOf(REMOTEXY_INPUTS_MARKER);
        var outputStart = request.body.config.indexOf(REMOTEXY_OUTPUTS_MARKER);
        var variablesEnd = request.body.config.indexOf(REMOTEXY_VARIABLES_END_MARKER);

        // Extract input variables
        inputVariableNames[request.body.id + "*"] = [];

	if (inputStart > 0) {
            var inputConfig = request.body.config.slice(inputStart + REMOTEXY_INPUTS_MARKER.length,
                   (outputStart>0)?outputStart:variablesEnd).split("\n");

            for (var x = 0; x < inputConfig.length; x++) {
                var input = inputConfig[x].match(/(?:unsigned|signed) char (\w+);/);

                if (input != null) {
                    inputVariableNames[request.body.id + "*"].push(input[1]);
                }
            }
        }

        // Extract output variables
        outputVariableNames[request.body.id + "*"] = [];
        if (outputStart > 0) {
            var outputConfig = request.body.config.slice(outputStart + REMOTEXY_OUTPUTS_MARKER.length, variablesEnd).split("\n");

            for (var x = 0; x < outputConfig.length; x++) {
                var output = outputConfig[x].match(/(?:unsigned|signed)? char (\w+)(?:\[(\d+)\])?;\s+\/\* (string|(=(-?\d+)+\.\.(\d+)))/);

                if (output != null) {
                    outputVariableNames[request.body.id + "*"].push(output[1]);
                }
            }
        }

        result.sendStatus(200);
    });

}
