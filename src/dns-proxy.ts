interface DnsProxy {
  createServer() : DnsProxy,
  start() : Promise<void>
}
