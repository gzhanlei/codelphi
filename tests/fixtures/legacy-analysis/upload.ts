import { checkPermission } from "./permission";

export function uploadFile(user: { canUpload: boolean }, content: string) {
  if (!checkPermission(user)) throw new Error("upload forbidden");
  return content;
}

export function listFiles(files: string[]) {
  return files;
}
