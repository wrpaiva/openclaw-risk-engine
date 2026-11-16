import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `docker save` da imagem sob teste para inspecionar CAMADAS e configuração sem executar nada. (`docker save -o` pendura neste
// Docker; a saída é redirecionada para arquivo.) As camadas NÃO são extraídas em disco: cada uma é lida em streaming de dentro
// do tar. Nada é publicado; o diretório temporário (só o tar) é removido no cleanup.

export interface SavedImage {
  readonly dir: string;
  /** Caminhos dos blobs de camada dentro do tar, em ordem. */
  readonly layers: readonly string[];
  /** Configuração da imagem (JSON bruto: env, history, user...). */
  readonly configText: string;
  /** Caminhos de todos os arquivos de cada camada. */
  listFiles(layer: string): string[];
  /** Quantas linhas do conteúdo (bytes) da camada contêm algum dos valores fixos. */
  countSecretHits(layer: string, secrets: readonly string[]): number;
  cleanup(): void;
}

export function saveImage(image: string): SavedImage {
  const dir = mkdtempSync(join(tmpdir(), 'openclaw-risk-e2e-image-'));
  const tarFile = join(dir, 'image.tar');
  const fd = openSync(tarFile, 'w');
  const save = spawnSync('docker', ['save', image], { stdio: ['ignore', fd, 'pipe'], timeout: 240_000 });
  closeSync(fd);
  if (save.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('docker save falhou');
  }
  const member = (name: string): string => {
    const r = spawnSync('tar', ['-xOf', tarFile, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('membro ausente no tar da imagem');
    return r.stdout;
  };
  const manifest = JSON.parse(member('manifest.json')) as { Config: string; Layers: string[] }[];
  const entry = manifest[0];
  if (!entry) throw new Error('manifest vazio');
  const configText = member(entry.Config);
  return {
    dir,
    layers: entry.Layers,
    configText,
    listFiles(layer) {
      const r = spawnSync('sh', ['-c', 'tar -xOf "$1" "$2" | tar -tf -', 'list', tarFile, layer], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      if (r.status !== 0) throw new Error('falha ao listar camada');
      return r.stdout.split('\n').filter((l) => l !== '');
    },
    countSecretHits(layer, secrets) {
      const patterns = join(dir, 'patterns.txt');
      writeFileSync(patterns, `${secrets.join('\n')}\n`, { mode: 0o600 });
      const r = spawnSync('sh', ['-c', 'tar -xOf "$1" "$2" | tar -xO 2>/dev/null | grep -a -c -F -f "$3"; true', 'scan', tarFile, layer, patterns], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      return Number(r.stdout.trim() || '0');
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
