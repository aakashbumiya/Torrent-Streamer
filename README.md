# LAN Torrent Streamer

A browser-only Angular + WebTorrent video streamer intended for use on a home Wi-Fi/LAN.

## What it does

- Paste a magnet URI
- Choose a `.torrent` file
- Detect video/audio files
- Stream a selected file in the browser
- Show peers, progress, download speed and upload speed
- No application backend or torrent storage
- Works with WebTorrent/WebRTC-compatible peers

WebTorrent in a browser can only connect to WebRTC/WebTorrent-capable peers; ordinary TCP/UDP-only torrent peers are not directly reachable from the browser.

## Requirements

Angular 22 currently requires a recent Node.js release. Check:

```bash
node -v
npm -v
```

Then install:

```bash
npm install
```

## Run with the Node relay

The browser cannot connect to ordinary UDP/TCP torrent peers directly. The Node
relay handles torrent discovery and peer connections, then serves an HTTP range
stream to Angular.

For development, use two terminals:

```bash
npm run start:backend
npm start
```

Open `http://localhost:4200` and enter a magnet link. For a single production
process, run:

```bash
npm run start:full
```

Then open `http://localhost:3000`.

## Run on the server itself

```bash
npm start
```

Open:

```text
http://localhost:4200
```

## Run on your Wi-Fi/LAN

```bash
npm run start:lan
```

Find the server's LAN IP.

Windows:

```powershell
ipconfig
```

Linux/macOS:

```bash
ip addr
# or
ifconfig
```

Then another device on the same Wi-Fi can try:

```text
http://SERVER_IP:4200
```

The full Node process also advertises a local discovery name:

```text
http://torrent-streamer.local:3000
```

The app displays the detected LAN addresses and a QR code for joining from a
phone or TV. mDNS support depends on the network and operating system; the IP
address remains the fallback.

### Optional LAN protection

Set a PIN when starting the backend to require it for torrent and streaming
requests:

```bash
LAN_PIN=2468 npm run start:full
```

The PIN is stored only in the current browser session. By default, API traffic
is also limited to loopback and private LAN addresses. To disable that check
for a trusted development setup:

```bash
LAN_ONLY=false npm run start:full
```

You can change the mDNS hostname with `LAN_HOSTNAME`:

```bash
LAN_HOSTNAME=movie-room.local npm run start:full
```

### Important: HTTPS for reliable remote-device streaming

The WebTorrent browser streaming endpoint uses a service worker. Service workers require a secure context. `http://localhost` is treated specially by browsers, but `http://192.168.x.x` is normally not a secure context.

For the most reliable phone/TV/LAN setup, use HTTPS.

One convenient approach is `mkcert`:

1. Install mkcert on the server.
2. Create a certificate for the server's LAN IP, for example:

```bash
mkcert 192.168.1.10 localhost
```

3. Start Angular with the generated certificate:

```bash
ng serve --host 0.0.0.0 --port 4200 --ssl \
  --ssl-cert ./192.168.1.10+1.pem \
  --ssl-key ./192.168.1.10+1-key.pem
```

4. Open:

```text
https://192.168.1.10:4200
```

On phones/tablets, the mkcert root CA must be trusted by the device for a clean HTTPS experience. Alternatively, for a home network, you can use a locally trusted reverse proxy such as Caddy.

## Firewall

If other devices cannot connect, allow TCP port 4200 through the server firewall.

Windows PowerShell (Administrator):

```powershell
New-NetFirewallRule -DisplayName "LAN Torrent Streamer" -Direction Inbound -Protocol TCP -LocalPort 4200 -Action Allow
```

Linux with UFW:

```bash
sudo ufw allow 4200/tcp
```

## Testing

Use a torrent you are authorized to access. For a known WebTorrent-compatible test torrent, see the official WebTorrent examples.

A browser can only retrieve torrents when there are WebRTC/WebTorrent-capable peers available.

## Notes

- The server is only hosting the Angular application. Torrent traffic is handled by the browser.
- Each browser/device creates its own WebTorrent client.
- The server does not proxy torrent data.
- Browser playback depends on the browser's supported media codecs/container.
- MKV playback can vary by browser/device; MP4 is generally the safest choice.
- Downloading pieces also means the browser may seed those pieces to other WebTorrent peers.

## Production build

```bash
npm run build
```

The generated static site is under:

```text
dist/lan-torrent-streamer/browser
```

You can serve that folder from Nginx, Caddy, Apache, or another static HTTP/HTTPS server.
