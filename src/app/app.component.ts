import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild
} from '@angular/core';

type TorrentFile = {
  index: number;
  name: string;
  length: number;
  type: string;
  streamUrl: string;
};

type Torrent = {
  name: string;
  infoHash: string;
  files: TorrentFile[];
  progress: number;
  downloaded: number;
  length: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  status?: string;
  error?: string;
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements AfterViewInit, OnDestroy {
  @ViewChild('video', { static: false }) video?: ElementRef<HTMLVideoElement>;

  magnet = '';
  selectedTorrentFile?: File;
  torrent?: Torrent;
  selectedFile?: TorrentFile;
  error = '';
  status = 'Ready';
  isAdding = false;
  isCopying = false;
  secureContext = window.isSecureContext;
  stats = {
    peers: 0,
    progress: 0,
    downloaded: 0,
    total: 0,
    downloadSpeed: 0,
    uploadSpeed: 0
  };

  private timer?: ReturnType<typeof setInterval>;
  private torrentHash?: string;
  private connectAbortController?: AbortController;
  private cancelRequested = false;

  constructor(private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    if (!this.secureContext) this.status = 'LAN HTTP mode';

    const params = new URLSearchParams(window.location.search);
    const storedMagnet = params.get('magnet');
    if (storedMagnet) {
      this.magnet = decodeURIComponent(storedMagnet);
      this.start();
    }
  }

  onTorrentFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedTorrentFile = input.files?.[0];
  }

  onMagnetKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !this.isAdding) this.start();
  }

  clearMagnet(): void {
    this.magnet = '';
    this.error = '';
    this.updateUrlFromMagnet();
  }

  private normalizeTorrentInput(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^magnet:/i.test(trimmed)) return trimmed;

    const hash = trimmed.replace(/^urn:btih:/i, '').replace(/\s+/g, '').toLowerCase();
    if (/^[0-9a-f]{40}$/i.test(hash)) return `magnet:?xt=urn:btih:${hash}`;
    return '';
  }

  private updateUrlFromMagnet(): void {
    const url = new URL(window.location.href);
    const normalized = this.normalizeTorrentInput(this.magnet);
    if (normalized) {
      url.searchParams.set('magnet', encodeURIComponent(normalized));
    } else {
      url.searchParams.delete('magnet');
    }
    window.history.replaceState({}, '', url);
  }

  async copyHash(): Promise<void> {
    if (!this.torrent?.infoHash || !navigator.clipboard) return;
    await navigator.clipboard.writeText(this.torrent.infoHash);
    this.isCopying = true;
    this.cdr.markForCheck();
    setTimeout(() => {
      this.isCopying = false;
      this.cdr.markForCheck();
    }, 1600);
  }

  async start(): Promise<void> {
    this.error = '';
    const normalizedMagnet = this.normalizeTorrentInput(this.magnet);
    if (!normalizedMagnet) {
      this.showError('Paste a magnet link or a 40-character info hash.');
      return;
    }

    this.magnet = normalizedMagnet;
    this.cancelRequested = false;
    this.connectAbortController = new AbortController();
    await this.stop();
    this.isAdding = true;
    this.status = 'Connecting to torrent peers…';
    this.cdr.markForCheck();

    try {
      const response = await fetch('/api/torrents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: normalizedMagnet }),
        signal: this.connectAbortController.signal
      });
      const request = await response.json();
      if (!response.ok) throw new Error(request.error || 'Could not add torrent.');

      this.torrentHash = request.infoHash;
      this.updateUrlFromMagnet();
      this.status = 'Downloading torrent metadata…';
      const torrent = await this.waitForMetadata(request.infoHash);
      this.torrent = torrent;
      this.isAdding = false;
      this.status = 'Torrent metadata received';
      this.stats.total = torrent.length;

      const videoFiles = torrent.files.filter(file => this.isVideo(file));
      this.selectedFile = videoFiles[0] ?? torrent.files[0];
      if (this.selectedFile) this.streamFile(this.selectedFile);
      this.startStats(torrent.infoHash);
      this.cdr.markForCheck();
    } catch (err: any) {
      if (this.cancelRequested || err?.name === 'AbortError') {
        this.status = 'Connection cancelled';
        this.isAdding = false;
        this.error = '';
        this.cdr.markForCheck();
        return;
      }
      this.showError(err?.message ?? 'Could not connect to the torrent backend.');
    }
  }

  cancelConnect(): void {
    this.cancelRequested = true;
    this.connectAbortController?.abort();
    this.clearStats();
    this.torrentHash = undefined;
    this.torrent = undefined;
    this.selectedFile = undefined;
    this.isCopying = false;
    this.isAdding = false;
    this.error = '';
    this.stats = { peers: 0, progress: 0, downloaded: 0, total: 0, downloadSpeed: 0, uploadSpeed: 0 };
    this.status = 'Connection cancelled';
    this.cdr.markForCheck();
  }

  selectFile(file: TorrentFile): void {
    if (!this.torrent) return;
    this.selectedFile = file;
    this.streamFile(file);
    this.cdr.markForCheck();
  }

  private streamFile(file: TorrentFile): void {
    const player = this.video?.nativeElement;
    if (!player) {
      setTimeout(() => this.streamFile(file), 100);
      return;
    }

    player.src = file.streamUrl;
    player.onerror = () => this.showError('The browser could not decode this video stream.');
    player.load();
    this.status = `Streaming: ${file.name}`;
    player.play().catch(() => {
      this.status = 'Press Play to start streaming';
      this.cdr.markForCheck();
    });
  }

  async stop(): Promise<void> {
    this.clearStats();
    if (this.torrentHash) {
      await fetch(`/api/torrents/${encodeURIComponent(this.torrentHash)}`, { method: 'DELETE' }).catch(() => {});
    }
    this.torrentHash = undefined;
    this.torrent = undefined;
    this.selectedFile = undefined;
    this.isCopying = false;
    this.stats = { peers: 0, progress: 0, downloaded: 0, total: 0, downloadSpeed: 0, uploadSpeed: 0 };
    this.status = 'Ready';
    this.updateUrlFromMagnet();
    this.cdr.markForCheck();
  }

  formatBytes(value: number): string {
    if (!value || value < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  formatSpeed(value: number): string {
    return `${this.formatBytes(value)}/s`;
  }

  formatPercent(value: number): string {
    return `${Math.min(100, Math.max(0, value * 100)).toFixed(1)}%`;
  }

  isVideo(file: TorrentFile): boolean {
    return /\.(mp4|m4v|webm|mov|ogv|mkv|m4a|mp3)$/i.test(file.name);
  }

  private async waitForMetadata(infoHash: string): Promise<Torrent> {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (this.cancelRequested || this.connectAbortController?.signal.aborted) {
        throw new Error('Connection cancelled.');
      }

      const response = await fetch(`/api/torrents/${encodeURIComponent(infoHash)}`, {
        signal: this.connectAbortController?.signal
      });
      const torrent = await response.json();
      if (!response.ok || torrent.status === 'error') {
        throw new Error(torrent.error || 'The backend could not load this torrent.');
      }
      if (torrent.status === 'ready') return torrent;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 1000);
        const onAbort = () => {
          clearTimeout(timeout);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        };
        this.connectAbortController?.signal.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => {
          this.connectAbortController?.signal.removeEventListener('abort', onAbort);
          clearTimeout(timeout);
          resolve(undefined);
        }, 1000);
      });
    }
    throw new Error('The backend could not find peers for this torrent after 120 seconds.');
  }

  private startStats(infoHash: string): void {
    this.clearStats();
    this.timer = setInterval(async () => {
      const response = await fetch(`/api/torrents/${encodeURIComponent(infoHash)}`).catch(() => undefined);
      if (!response?.ok) return;
      const torrent = await response.json();
      this.stats = {
        peers: torrent.numPeers ?? 0,
        progress: torrent.progress ?? 0,
        downloaded: torrent.downloaded ?? 0,
        total: torrent.length ?? 0,
        downloadSpeed: torrent.downloadSpeed ?? 0,
        uploadSpeed: torrent.uploadSpeed ?? 0
      };
      this.cdr.markForCheck();
    }, 1000);
  }

  private clearStats(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private showError(message: string): void {
    this.error = message;
    this.status = 'Error';
    this.isAdding = false;
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    this.clearStats();
  }
}
