import { createSocket } from 'dgram'
import fs from 'fs'

const Forwarder = {
  _socket: undefined,
  init() {
    if (!this._socket) {
      this._socket = createSocket('udp4')
    }

    return this
  },
  send(buf) {
    this._socket.send(buf, 53, '8.8.8.8', () => {
      console.log('Request sent to upstream')
    })

    return new Promise((resolve, reject) => {
      const handleMessage = (msg, remoteInfo) => {
        removeListeners()
        resolve(msg)
      }

      const handleError = error => {
        removeListeners()
        reject(error)
      }

      const removeListeners = () => {
        this._socket.removeListener('message', handleMessage)
        this._socket.removeListener('error', handleError)
      }

      this._socket.on('message', handleMessage)
      this._socket.on('error', handleError)
    })
  }
}

const dnsProxyServer = {
  _socket: undefined,
  _forwarder: undefined,
  _blacklist: undefined,

  // Support exact match first
  // TODO: support pattern matching
  isDomainBlackListed(name = '') {
    return this._blacklist.includes(name)
  },
  getQuestionDomain(buffer) {
    // First 12 bytes is DNS header
    // We only want the questions part
    // Only handle 1 question per request
    const skipOffset = 12
    const NULL_BYTE = 0
    const labels = []

    // When `lengthIndicator` is set to 0, it means that is the end of the questions
    let lengthIndicator = buffer.readUInt8(skipOffset)
    let currentIndex = skipOffset

    while (lengthIndicator !== NULL_BYTE) {
      currentIndex++
      labels.push(
        buffer.toString('ascii', currentIndex, currentIndex + lengthIndicator)
      )

      currentIndex += lengthIndicator
      lengthIndicator = buffer.readUInt8(currentIndex)
    }

    if (labels.length === 0) {
      return { name: '', endOffset: skipOffset }
    }
    return {
      name: labels.join('.'),
      endOffset: currentIndex
    }
  },
  generateResponse(rqBuf, { questionSectionEndOffset }) {
    console.log('Block hit')

    // Response ID must be the same with Request ID
    const rsId = rqBuf.slice(0, 2)
    // QR -- OPCODE -- AA -- TC -- RD -- RA -- Z -- RCODE
    // 1  --  000 0 -- 0  -- 0  -- 1  -- 1  -- 000 -- 0000
    // 1000 0001 1000 0000
    // 8    1     8   0
    // 81 80
    // Flags in header section
    const flags = Buffer.from([0x81, 0x80])
    const qdCount = Buffer.from([0, 1])
    const answerCount = Buffer.from([0, 1])
    // Keep it to 0 for now
    const nsCount = Buffer.from([0, 0])
    const arCount = Buffer.from([0, 0])

    const header = Buffer.concat([
      rsId,
      flags,
      qdCount,
      answerCount,
      nsCount,
      arCount
    ])

    const questions = rqBuf.slice(
      header.length,
      questionSectionEndOffset + 5 // null-byte and 4 bytes for type and class, each takes 2 bytes
    )

    const records = Buffer.concat([
      Buffer.from([0xc0, 0x0c]),     // name
      Buffer.from([0, 1]),           // type
      Buffer.from([0, 1]),           // class
      Buffer.from([0, 0, 1, 300]),   // ttl
      Buffer.from([0, 4]),           // length
      Buffer.from([127, 0, 0, 1])    // ip - loopback interface
    ])

    return Buffer.concat([
      header,
      questions,
      records
    ])
  },

  async handleDnsRequest(msg, rinfo) {
    const socket = this._socket

    try {
      const { name, endOffset: questionSectionEndOffset } = this.getQuestionDomain(msg)
      if (this.isDomainBlackListed(name)) {
        socket.send(this.generateResponse(msg, { questionSectionEndOffset }), rinfo.port, rinfo.address)
      } else {
        const responseBuf = await this._forwarder.send(msg)
        socket.send(responseBuf, rinfo.port, rinfo.address)
      }
    } catch (err) {
      console.log('Forwarding error', err)
    }
  },

  // Check if forwarder not injected then create a new one
  start({ forwarder = Forwarder.init() } = {}) {
    this._forwarder = forwarder
    const socket = this._socket = createSocket('udp4')
    // For simplicity, load everything into memory!!
    // TODO: finding another approach
    this._blacklist = fs
      .readFileSync('adlist/youtube')
      .toString()
      .split("\n");

    socket.on('message', this.handleDnsRequest.bind(this))

    socket.on('error', error => {
      console.log(error)
      socket.close()
    })

    socket.on('close', () => {
      console.log('Gracefully closed')
    })

    socket
      .bind(53, () => {
        console.log('DNS Proxy Server started', socket.address())
      })
  }
}

dnsProxyServer.start()

