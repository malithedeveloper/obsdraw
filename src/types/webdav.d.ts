declare module 'webdav' {
  export type FileType = 'file' | 'directory';
  export interface FileStat {
    filename: string;
    basename: string;
    lastmod?: string | Date;
    size?: number;
    type: FileType;
    mime?: string;
    etag?: string;
  }
  export interface GetFileOptions {
    format?: 'binary' | 'text';
  }
  export interface PutFileOptions {
    overwrite?: boolean;
  }
  export interface MoveCopyOptions {
    overwrite?: boolean;
  }
  export interface WebDAVClient {
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<FileStat>;
    createDirectory(path: string): Promise<void>;
    getFileContents(path: string, options?: GetFileOptions): Promise<Buffer | ArrayBuffer | string>;
    putFileContents(path: string, data: Buffer | ArrayBuffer | string, options?: PutFileOptions): Promise<void>;
    deleteFile(path: string): Promise<void>;
    moveFile(from: string, to: string, options?: MoveCopyOptions): Promise<void>;
    copyFile(from: string, to: string, options?: MoveCopyOptions): Promise<void>;
    createReadStream(path: string, options?: { range?: { start?: number; end?: number } }): NodeJS.ReadableStream;
  }
  export function createClient(url: string, options: { username: string; password: string; headers?: Record<string,string> }): WebDAVClient;
}
