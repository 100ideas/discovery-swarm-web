const signalhubws = require('signalhubws')
const webrtcSwarm = require('@geut/discovery-swarm-webrtc')
const DSS = require('discovery-swarm-stream/client')
const websocket = require('websocket-stream')
const crypto = require('crypto')

const EventEmitter = require('events')

const DEFAULT_SIGNALHUB = ['wss://signalhubws.mauve.moe']
const DEFAULT_DISCOVERY = 'wss://discoveryswarm.mauve.moe'
const LOCALHOST_DISCOVERY = 'ws://localhost:3472'
const APP_NAME = 'discovery-swarm-web'
const DEFAULT_MAX_CONNECTIONS = Infinity
const JOIN_DELAY = 2000
const SYNC_NET_DELAY = 5000

// Check if the page was loaded from HTTPS
const IS_SECURE = self.location.href.startsWith('https')

module.exports = class DiscoverySwarmWeb extends EventEmitter {
  constructor (opts = {}) {
    super()
    const signalhubURL = opts.signalhub || DEFAULT_SIGNALHUB
    const discoveryURL = opts.discovery || DEFAULT_DISCOVERY

    const id = opts.id || crypto.randomBytes(32)
    const stream = opts.stream

    this.id = id
    this.stream = stream
    this.maxConnections = opts.maxConnections || DEFAULT_MAX_CONNECTIONS

    const isInstance = (typeof signalhubURL === 'object' && !Array.isArray(signalhubURL))
    const hub = isInstance
      ? signalhubURL : signalhubws(APP_NAME, signalhubURL.map(setSecure))

    this.channels = new Map()

    this.hub = hub

    this.webrtc = webrtcSwarm({
      id,
      stream,
      hub
    })

    this.dss = new DiscoverySwarmStreamWebsocket({
      id,
      stream,
      discovery: setSecure(discoveryURL)
    })

    this.webrtc.on('connection', (conn, info) => this._handleConnection(conn, info))
    this.dss.on('connection', (conn, info) => this._handleConnection(conn, info))
  }

  _handleConnection (connection, info) {
    const channelNameString = info.channel.toString('hex')
    const currentCount = this.channels.get(channelNameString)

    if (currentCount >= this.maxConnections) {
      connection.end()
    } else {
      this.channels.set(channelNameString, currentCount + 1)

      let hasClosed = false
      const handleClose = () => {
        if (hasClosed) return
        hasClosed = true
        if (!this.channels.has(channelNameString)) return
        const count = this.channels.get(channelNameString)
        this.channels.set(channelNameString, count - 1)
        if (!count) {
          this.leave(channelNameString)
          this.join(channelNameString)
        }
      }

      connection.once('close', handleClose)
      connection.once('error', handleClose)

      this.emit('connection', connection, info)
    }
  }

  join (channelName, opts = {}) {
    const channelNameString = channelName.toString('hex')

    if (this.channels.has(channelNameString)) return

    this.channels.set(channelNameString, 0)

    this.webrtc.join(channelName, opts)

    const joinDSS = () => {
      if (!this.channels.has(channelNameString)) return
      this.removeListener('connection', handleJoined)
      this.dss.join(channelName, opts)
    }

    const handleJoined = (connection, info) => {
      if (info.channel.toString('hex') !== channelNameString) return
      this.removeListener('connection', handleJoined)
      clearTimeout(connectTimer)
      connectTimer = setTimeout(joinDSS, SYNC_NET_DELAY)
    }

    // Wait a bit for WebRTC connections to come in before connecting to the gateway
    // This will make it more likely that any initial sync would happen over WebRTC
    let connectTimer = setTimeout(joinDSS, JOIN_DELAY)

    this.on('connection', handleJoined)
  }

  leave (channelName, opts = {}) {
    const channelNameString = channelName.toString('hex')

    if (!this.channels.has(channelNameString)) return

    this.channels.delete(channelNameString)

    this.webrtc.leave(channelName, opts)
    this.dss.leave(channelName, opts)
  }

  close (cb) {
    this.dss.close(() => {
      this.webrtc.close(cb)
    })
  }

  destroy (cb) {
    this.close(cb)
  }
}

class DiscoverySwarmStreamWebsocket extends DSS {
  constructor (opts) {
    const discovery = opts.discovery
    const stream = opts.stream
    const id = opts.id

    const connection = websocket(LOCALHOST_DISCOVERY)

    super({
      id,
      connection,
      stream
    })

    this._handleDisconnected = () => {
      this._reconnect()
    }
    this.discoveryURL = discovery

    connection.once('error', this._handleDisconnected)
    this.on('disconnected', this._handleDisconnected)
  }

  _reconnect () {
    const connection = websocket(this.discoveryURL)
    this.reconnect(connection)
  }

  close (cb) {
    this.removeListener('disconnected', this._handleDisconnected)
    super.close(cb)
  }
}

function setSecure (url) {
  if (IS_SECURE) {
    if (url.startsWith('http:')) {
      return 'https:' + url.slice(6)
    } else if (url.startsWith('ws:')) {
      return 'wss:' + url.slice(3)
    } else {
      return url
    }
  } else {
    if (url.startsWith('https:')) {
      return 'http:' + url.slice(7)
    } else if (url.startsWith('wss:')) {
      return 'ws:' + url.slice(4)
    } else {
      return url
    }
  }
}
