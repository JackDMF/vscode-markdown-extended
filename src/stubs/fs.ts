// Stub for Node.js 'fs' module in the VS Code web extension host.
// File system operations return safe empty values so bundled code that
// references fs (e.g. contributorService, config) degrades gracefully
// instead of throwing at import time.

export function existsSync(_path: string): boolean {
    return false;
}

export function readFileSync(_path: string, _options?: any): Buffer {
    return Buffer.alloc(0);
}

export function writeFileSync(_path: string, _data: any, _options?: any): void {}

export function mkdirSync(_path: string, _options?: any): void {}

export function statSync(_path: string): never {
    throw new Error('fs.statSync is not available in the web extension host');
}

export function exists(_path: string, callback: (exists: boolean) => void): void {
    callback(false);
}

export function mkdir(
    _path: string,
    optionsOrCallback: any,
    callback?: (err?: Error | null) => void
): void {
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (cb) { cb(null); }
}

export const promises = {
    writeFile: (_path: string, _data: any, _options?: any): Promise<void> =>
        Promise.resolve(),
    mkdir: (_path: string, _options?: any): Promise<void> =>
        Promise.resolve(),
    access: (_path: string, _mode?: number): Promise<void> =>
        Promise.reject(new Error('File not accessible in web extension host')),
    readFile: (_path: string, _options?: any): Promise<Buffer> =>
        Promise.reject(new Error('File not accessible in web extension host')),
    rm: (_path: string, _options?: any): Promise<void> =>
        Promise.resolve(),
};
