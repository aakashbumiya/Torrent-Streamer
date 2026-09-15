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

  constructor(private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    if (!this.secureContext) this.status = 'LAN HTTP mode';
  }

  onTorrentFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedTorrentFile = input.files?.[0];
  }

  async start(): Promise<void> {
    this.error = '';
    if (!this.magnet.trim()) {
      this.showError('Paste a magnet link. Backend mode currently accepts magnet links.');
      return;
    }

    await this.stop();
    this.isAdding = true;
    this.status = 'Connecting to torrent peers…';
    this.cdr.markForCheck();

    try {
      const response = await fetch('/api/torrents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: this.magnet.trim() })
      });
      const request = await response.json();
      if (!response.ok) throw new Error(request.error || 'Could not add torrent.');

      this.torrentHash = request.infoHash;
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
      this.showError(err?.message ?? 'Could not connect to the torrent backend.');
    }
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
    this.stats = { peers: 0, progress: 0, downloaded: 0, total: 0, downloadSpeed: 0, uploadSpeed: 0 };
    this.status = 'Ready';
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
      const response = await fetch(`/api/torrents/${encodeURIComponent(infoHash)}`);
      const torrent = await response.json();
      if (!response.ok || torrent.status === 'error') {
        throw new Error(torrent.error || 'The backend could not load this torrent.');
      }
      if (torrent.status === 'ready') return torrent;
      await new Promise(resolve => setTimeout(resolve, 1000));
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
