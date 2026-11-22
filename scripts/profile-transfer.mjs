import { exportProfile, importProfile } from '../desktop/profile-transfer.mjs';

const [operation, home, archive] = process.argv.slice(2);
if (!['export', 'import'].includes(operation) || !home || !archive) {
  process.stderr.write('Stop DSH first. Use: node scripts/profile-transfer.mjs export|import DSH_HOME ARCHIVE\n');
  process.exitCode = 2;
} else {
  let passphrase = '';
  for await (const chunk of process.stdin) {
    passphrase += chunk;
    if (passphrase.length > 530) throw new Error('Recovery password is too long.');
  }
  passphrase = passphrase.replace(/\r?\n$/, '');
  const operationFn = operation === 'export' ? exportProfile : importProfile;
  const result = await operationFn(home, archive, passphrase);
  console.log(result?.previous ? 'Original profile retained at ' + result.previous : 'Profile transfer complete.');
}
