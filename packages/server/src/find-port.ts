import net from 'node:net'

export async function findPort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port++) {
    const free = await new Promise<boolean>(resolve => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error(`No free port found in ${start}..${start + 49}`)
}
