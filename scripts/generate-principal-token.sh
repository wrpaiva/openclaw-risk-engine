#!/bin/sh
# Gera um token Bearer de 256 bits e o SHA-256 correspondente (o que vai em RISK_PRINCIPALS_FILE).
# O token é impresso uma única vez, na saída padrão; nada é gravado em arquivo.
set -eu
node --input-type=module -e "
import { randomBytes, createHash } from 'node:crypto';
const token = randomBytes(32).toString('base64url');
console.log('token (guarde agora; não será exibido de novo): ' + token);
console.log('tokenSha256: ' + createHash('sha256').update(token, 'utf8').digest('hex'));
"
