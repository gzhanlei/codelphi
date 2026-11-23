export function checkPermission(user: { canUpload: boolean }) {
  return user.canUpload;
}
