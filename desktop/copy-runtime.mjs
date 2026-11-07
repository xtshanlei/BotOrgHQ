import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function copyRuntime({ appOutDir, packager }) {
  const runtime = fileURLToPath(new URL('./runtime', import.meta.url));
  // Copy the resolved dependency tree verbatim, including nested node_modules
  // and executable files. The app's normal file matcher excludes dependencies.
  cpSync(runtime, join(packager.getResourcesDir(appOutDir), 'runtime'), {
    recursive: true,
    verbatimSymlinks: true,
    filter: path => path !== join(runtime, 'package-lock.json')
  });
}
