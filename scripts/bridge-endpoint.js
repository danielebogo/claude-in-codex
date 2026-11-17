#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import { prepareLocalAuth, readLocalAuth, verifyHealthProof } from '../src/localAuth.js';

const [mode, directory, port] = process.argv.slice(2);
try {
  if (mode === 'prepare') {
    prepareLocalAuth(directory, { newInstallation: true });
  } else if (mode === 'verify') {
    const auth = readLocalAuth(directory);
    const challenge = crypto.randomBytes(32).toString('hex');
    const proof = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: Number(port), path: `/health?challenge=${challenge}`, agent: false }, (response) => {
        let body = '';
        response.on('error', reject);
        response.on('data', (chunk) => {
          if (body.length + chunk.length > 4096) request.destroy(new Error('Health proof exceeds 4 KiB.'));
          else body += chunk;
        });
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('Bridge health endpoint did not succeed.');
            resolve(JSON.parse(body));
          } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => request.destroy(new Error('Health proof timed out.')), 1000);
      request.on('close', () => clearTimeout(timer));
      request.on('error', reject);
    });
    if (!verifyHealthProof(auth, challenge, port, proof)) throw new Error('Listener identity does not match the bridge started by this installation.');
  } else {
    throw new Error('Use bridge-endpoint.js prepare <bridge-home> or verify <bridge-home> <port>.');
  }
} catch (error) {
  console.error(`Bridge endpoint: ${error.message}`);
  process.exitCode = 1;
}
