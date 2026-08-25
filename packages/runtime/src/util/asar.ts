import { existsSync } from 'node:fs';

/**
 * Electron keeps module URLs under the virtual app.asar path even when a file
 * is physically unpacked. External Node processes do not share that virtual
 * filesystem and the permission model would otherwise authorize the wrong
 * path, so child-process entry points must use their physical location.
 */
export function physicalAsarPath(path: string): string {
  const candidate = path.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2');
  return candidate !== path && existsSync(candidate) ? candidate : path;
}
