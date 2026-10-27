import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The publisher algorithm and LOCAL transport are exact copies. Only inert C#
// assembly metadata varies, as in the PHP alpha.5 cold-cache oracle.
export function ownedProducer(moduleUrl, directory, identity) {
  if (!/^[a-z0-9-]{1,80}$/.test(identity)) throw new Error('invalid owned producer identity');
  const sourceDirectory = dirname(fileURLToPath(moduleUrl));
  const publisher = readFileSync(join(sourceDirectory, 'process-tree.js'));
  const local = readFileSync(join(sourceDirectory, 'process-tree-local.js'));
  const supervisor = readFileSync(join(sourceDirectory, 'process-tree-supervisor-cs.js'));
  const text = supervisor.toString('utf8');
  if (text.split('static class Supervisor').length !== 2) throw new Error('cannot identify the single supervisor declaration');
  const variant = text.replace('static class Supervisor', `[assembly: System.Reflection.AssemblyDescription("owned cold oracle ${identity}")]\nstatic class Supervisor`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(directory, 'process-tree.js'), publisher);
  writeFileSync(join(directory, 'process-tree-local.js'), local);
  writeFileSync(join(directory, 'process-tree-supervisor-cs.js'), variant);
  return { moduleUrl: pathToFileURL(join(directory, 'process-tree.js')).href, publisherSha256: digest(publisher), originalSupervisorSha256: digest(supervisor), variantSupervisorSha256: digest(Buffer.from(variant)) };
}
