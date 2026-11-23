export async function loadUploader(modulePath: string) {
  return import(modulePath);
}
