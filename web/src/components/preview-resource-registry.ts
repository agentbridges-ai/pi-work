class PreviewResourceRegistry {
  private urls = new Set<string>();

  create(blob: Blob | MediaSource): string {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }

  revoke(url: string | undefined): void {
    if (!url) return;
    if (this.urls.delete(url)) {
      URL.revokeObjectURL(url);
    }
  }

  revokeAll(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  get size(): number {
    return this.urls.size;
  }
}

export const previewResourceRegistry = new PreviewResourceRegistry();
