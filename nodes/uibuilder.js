/**
 * Copyright (c) 2017 Julian Knight (Totally Information)
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

'use strict'

// Module name must match this nodes html file
var moduleName = 'uibuilder'

var debug = true

//var inited = false;
var settings = {}

var serveStatic = require('serve-static'),
    socketio = require('socket.io'),
    path = require('path'),
    fs = require('fs'),
    events = require('events'),
    nodeVersion = require('../package.json').version
    ;

var io

// Why?
var ev = new events.EventEmitter();
ev.setMaxListeners(0);

module.exports = function(RED) {
    'use strict';

    function nodeGo(config) {
        // Create the node
        RED.nodes.createNode(this, config)

        // copy 'this' object in case we need it in context of callbacks of other functions.
        var node = this

        // Create local copies of the node configuration (as defined in the .html file)
        node.name   = config.name || ''
        // TODO: This needs to be limited to a single path element
        node.url    = config.url  || 'uibuilder'
        node.fwdInMessages = config.fwdInMessages || true
        node.customFoldersReqd = config.customFoldersReqd || true
        // NOTE: When a node is redeployed - e.g. after the template is changed
        //       it is totally torn down and rebuilt so we cannot ever know
        //       whether the template was changed.
        node.template = config.template || '<p>{{ msg }}</p>';

        // The channel names for Socket.IO
        var ioChannels = {control: 'uiBuilderControl', client: 'uiBuilderClient', server: 'uiBuilder'}

        // Name of the fs path used to hold custom files & folders for all instances of uibuilder
        var customAppFolder = path.join(RED.settings.userDir, 'uibuilder')
        // Name of the fs path used to hold custom files & folders for THIS INSTANCE of uibuilder
        //   Files in this folder are also served to URL but take preference
        //   over those in the nodes folders (which act as defaults)
        var customFolder = path.join(customAppFolder, node.url)

        var ioClientsCount = 0

        // We need an http server to serve the page
        var app = RED.httpNode || RED.httpAdmin

        // Use httNodeMiddleware function which is defined in settings.js
        // as for the http in/out nodes
        var httpMiddleware = function(req,res,next) { next() }
        if (RED.settings.httpNodeMiddleware) {
            if ( typeof RED.settings.httpNodeMiddleware === 'function' ) {
                httpMiddleware = RED.settings.httpNodeMiddleware
            }
        }
        
        // This ExpressJS middleware runs when the vueui page loads - we'll use it at some point
        // maybe to pass a "room" name in custom header for IO to use
        // so that we can have multiple pages served
        // @see https://expressjs.com/en/guide/using-middleware.html
        function localMiddleware (req, res, next) {
            // Tell the client what namespace to use
            res.setHeader('x-uibuilder-namespace', node.url)
            res.cookie('uibuilder-namespace', node.url, {path: node.url, sameSite: true})
            next()
        }

        // ---- Add custom folder structure if requested ---- //
        if ( node.customFoldersReqd ) {
            // NOTE: May be better as async calls?
            // Make sure the global custom folder exists first
            try {
                fs.mkdirSync(customAppFolder)
                fs.accessSync( customAppFolder, fs.constants.W_OK )
            } catch (e) {
                if ( e.code !== 'EEXIST' ) {
                    debug && RED.log.error('UIBUILDER - uibuilder custom folder ERROR, path: ' + path.join(RED.settings.userDir, customAppFolder) + ', error: ' + e.message)
                }
            }
            // Then make sure the folder for this node instance exists
            try {
                fs.mkdirSync(customFolder)
                fs.accessSync(customFolder, fs.constants.W_OK)
            } catch (e) {
                if ( e.code !== 'EEXIST' ) {
                    debug && RED.log.error('UIBUILDER - uibuilder local custom folder ERROR: ' + e.message)
                }
            }
            // Add static path for local custom files
            app.use( urlJoin(node.url), serveStatic(customFolder) )
        }
        // -------------------------------------------------- //
        
        // Create a new, additional static http path to enable
        // loading of central static resources for uibuilder
        fs.stat(path.join(__dirname, 'dist', 'index.html'), function(err, stat) {
            if (!err) {
                // If the ./dist/index.html exists use the dist folder... 
                app.use( urlJoin(node.url), httpMiddleware, localMiddleware, serveStatic( path.join( __dirname, 'dist' ) ) );
            } else {
                // ... otherwise, use dev resources at ./src/
                debug && RED.log.audit({ 'UIbuilder': node.url+' Using development folder' });
                app.use( urlJoin(node.url), httpMiddleware, localMiddleware, serveStatic( path.join( __dirname, 'src' ) ) );
                // Include vendor resource source paths if needed
                var vendor_packages = [
                    'normalize.css',
                    //'sprintf-js',
                    //'jquery', 'jquery-ui'
                ]
                vendor_packages.forEach(function (packageName) {
                    //debug && RED.log.audit({ 'UIbuilder': 'Adding vendor paths', 'url':  join(node.url, 'vendor', packageName), 'path': path.join(__dirname, 'node_modules', packageName)});
                    app.use( urlJoin(node.url, 'vendor', packageName), serveStatic(path.join(__dirname, '..', 'node_modules', packageName)) );
                })
                // TODO: Add ~/.node-red (userDir?) level vendor packages too.
            }
        })

        var fullPath = urlJoin( RED.settings.httpNodeRoot, node.url );
        if ( node.customFoldersReqd ) {
            RED.log.info('UI Builder - Version ' + nodeVersion + ' started at ' + fullPath)
            RED.log.info('UI Builder - Local file overrides at ' + customFolder)
        } else {
            RED.log.info('UI Builder - Version ' + nodeVersion + ' started at ' + fullPath)
            RED.log.info('UI Builder - Local file overrides not requested')
        }

        // Start Socket.IO with a namespace to match the url path
        if (!io) {
            io = socketio.listen(RED.server) // listen === attach
            io.set('transports', ['polling', 'websocket'])
            ioClientsCount = 0
            node.status({ fill: 'blue', shape: 'dot', text: 'Socket Created' })
        }
        // Check that all incoming SocketIO data has the IO cookie
        // TODO: Needs a bit more work to add some real security
        io.use(function(socket, next){
            if (socket.request.headers.cookie) return next()
            next(new Error('UIbuilder:NodeGo:io.use - Authentication error'))
        });

        // When someone loads the page, it will try to connect over Socket.IO
        // note that the connection returns the socket instance to monitor for responses from 
        // the ui client instance
        io.of(node.url).on('connection', function(socket) {
            ioClientsCount++
            debug && RED.log.audit({ 
                'UIbuilder': node.url+' Socket connected', 'clientCount': ioClientsCount, 'ID': socket.id, 'Cookie': socket.handshake.headers.cookie
            })
            node.status({ fill: 'green', shape: 'dot', text: 'connected '+ioClientsCount })
            //console.log('--socket.request.connection.remoteAddress--')
            //console.dir(socket.request.connection.remoteAddress)
            //console.log('--socket.handshake.address--')
            //console.dir(socket.handshake.address)
            //console.dir(io.sockets.connected)

            //io.of('/'+node.url).emit( ioChannels.control, { 'type': 'initial-connection'} )

            // if the client sends a specific msg channel...
            socket.on(ioChannels.client, function(msg) {
                debug && RED.log.audit({ 
                    'UIbuilder': node.url+' Data recieved from client', 'ID': socket.id, 'Cookie': socket.handshake.headers.cookie, 'data': msg 
                })

                // Send out the message for downstream flows
                // TODO: This should probably have safety validations!
                node.send(msg)
            });

            socket.on('disconnect', function(reason) {
                ioClientsCount--
                debug && RED.log.audit({
                    'UIbuilder': node.url+' Socket disconnected', 'clientCount': ioClientsCount,
                    'reason': reason, 'ID': socket.id, 'Cookie': socket.handshake.headers.cookie
                })
                node.status({ fill: 'green', shape: 'ring', text: 'connected ' + ioClientsCount })
            })
        })

        // handler function for node input events (when a node instance receives a msg)
        function nodeInputHandler(msg) {
            debug && RED.log.info('UIbuilder:nodeGo:nodeInputHandler - emit received msg - Namespace: ' + node.url) //debug

            // pass the complete msg object to the vue ui client
            // TODO: This should probably have some safety validation on it
            io.of(node.url).emit(ioChannels.server, msg)

        } // -- end of msg recieved processing -- //
        node.on('input', nodeInputHandler)

        // Do something when Node-RED is closing down
        // which includes when this node instance is redeployed
        node.on('close', function() {
            //debug && RED.log.info('VUEUI:nodeGo:on-close') //debug

            // Let the clients know we are closing down
            io.of(node.url).emit( ioChannels.control, { 'type': 'shutdown' } )

            node.status({})
            node.removeListener('input', nodeInputHandler)

            // Disconnect all Socket.IO clients
            // WARNING: TODO: If we do this, a client cannot reconnect after redeployment
            //                so the user has to reload the page
            //  They have to do this at the moment anyway so might as well.
            const MyNamespace = io.of(node.url); // Get Namespace
            const connectedNameSpaceSockets = Object.keys(MyNamespace.connected); // Get Object with Connected SocketIds as properties
            connectedNameSpaceSockets.forEach(socketId => {
                MyNamespace.connected[socketId].disconnect(); // Disconnect Each socket
            });
            MyNamespace.removeAllListeners(); // Remove all Listeners for the event emitter
            delete io.nsps[node.url]; // Remove from the server namespaces

            /*
            //console.dir(io.of('/'+node.url).connected)
            Object.keys(io.of(node.url).connected).forEach(function(id){
                console.log(id) // /someotherurl#7wHCCbdBTAFLyTOSAAAA
                io.sockets.connected[id].disconnect(true)
            })
            */
            io = null

            // TODO Do we need to remove the app.use paths too? YES!
            // This code borrowed from the http nodes
            app._router.stack.forEach(function(route,i,routes) {
                if ( route.route && route.route.path === node.url ) {
                    routes.splice(i,1)
                }
            });

        })

    } // ---- End of nodeGo (initialised node instance) ---- //

    // Register the node by name. This must be called before overriding any of the
    // Node functions.
    RED.nodes.registerType(moduleName, nodeGo);
}

// ========== UTILITY FUNCTIONS ================ //

//from: http://stackoverflow.com/a/28592528/3016654
function urlJoin() {
    var trimRegex = new RegExp('^\\/|\\/$','g');
    var paths = Array.prototype.slice.call(arguments);
    return '/'+paths.map(function(e){return e.replace(trimRegex,'');}).filter(function(e){return e;}).join('/');
}

// EOF