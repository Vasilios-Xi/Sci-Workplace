import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import YAML from 'yaml';
import type { ContextContribution, SkillDescriptor } from '@openlab/protocol';
import { atomicWriteJson, atomicWriteText, readJsonFile } from '../util/files.js';

interface ParsedSkill {
  descriptor: SkillDescriptor;
  instructions: string;
}

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function parseFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } {
const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(content);
  if (!match) return { metadata: {}, body: content };
  const parsed = YAML.parse(match[1] ?? '') as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Skill frontmatter 必须是对象');
  return { metadata: parsed as Record<string, unknown>, body: content.slice(match[0].length) };
}

function normalizeAllowedTools(value: unknown): string[] {
  const tools = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string' ? value.split(/[ ,]+/u).filter(Boolean) : [];
  return [...new Set(tools.filter((tool) => /^[a-zA-Z0-9_.:-]{1,128}$/u.test(tool)))].slice(0, 128);
}

function normalizeReferences(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(entries.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))].slice(0, 10);
}

function loadReferences(directory: string, value: unknown): { paths: string[]; content: string[] } {
  const root = realpathSync(directory);
  const paths: string[] = [];
  const content: string[] = [];
  let totalBytes = 0;
  for (const reference of normalizeReferences(value)) {
    if (isAbsolute(reference)) throw new Error(`Skill 引用必须使用相对路径：${reference}`);
    const target = resolve(directory, reference);
    if (!within(directory, target) || !existsSync(target) || !statSync(target).isFile()) throw new Error(`Skill 引用文件无效：${reference}`);
    const realTarget = realpathSync(target);
    if (!within(root, realTarget)) throw new Error(`Skill 引用越过扩展目录：${reference}`);
    const text = readFileSync(realTarget, 'utf8');
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > 500_000) throw new Error('Skill 引用文件总大小超过 500 KB');
    const normalized = relative(root, realTarget).replaceAll('\\', '/');
    paths.push(normalized);
    content.push(`<skill-reference path="${normalized.replace(/["&<>]/gu, '_')}">\n${text.trim()}\n</skill-reference>`);
  }
  return { paths, content };
}

function discoverSkillDirectories(root: string, maxDepth = 3, maxDirectories = 200): string[] {
  const output: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (output.length >= maxDirectories) return;
    output.push(directory);
    if (depth >= maxDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (output.length >= maxDirectories) break;
      if (entry.isDirectory()) visit(join(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return output;
}

const MAX_SKILL_FILES = 2_000;
const MAX_SKILL_BYTES = 50 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;

function validateSkillRelativePath(path: string): void {
  if (path.length > 400) throw new Error('Skill 路径过长');
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[:\0]/u.test(segment) || /[. ]$/u.test(segment)) throw new Error(`Skill 包含不安全路径：${path}`);
    const stem = segment.split('.')[0]?.toLocaleLowerCase();
    if (stem && /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(stem)) throw new Error(`Skill 包含 Windows 保留路径：${path}`);
  }
}

function auditSkillTree(root: string): void {
  const resolvedRoot = resolve(root);
  let files = 0;
  let bytes = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(resolvedRoot, path).replaceAll('\\', '/');
      validateSkillRelativePath(rel);
      if (entry.isSymbolicLink()) throw new Error(`Skill 不得包含符号链接或目录联接：${rel}`);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile()) throw new Error(`Skill 包含不支持的文件类型：${rel}`);
      const size = statSync(path).size;
      if (size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill 单文件超过 5 MB：${rel}`);
      files += 1;
      bytes += size;
      if (files > MAX_SKILL_FILES) throw new Error(`Skill 文件数量超过上限（${MAX_SKILL_FILES}）`);
      if (bytes > MAX_SKILL_BYTES) throw new Error('Skill 解压后大小超过 50 MB');
    }
  };
  visit(resolvedRoot);
}

function validateSkillZip(zip: AdmZip, destination: string): void {
  const entries = zip.getEntries();
  if (entries.length > MAX_SKILL_FILES) throw new Error(`Skill 压缩包文件数量超过上限（${MAX_SKILL_FILES}）`);
  let bytes = 0;
  for (const entry of entries) {
    const normalized = entry.entryName.replaceAll('\\', '/').replace(/\/$/u, '');
    if (normalized) validateSkillRelativePath(normalized);
    if (!within(destination, resolve(destination, entry.entryName))) throw new Error(`Skill 压缩包包含越界路径：${entry.entryName}`);
    const size = Number(entry.header.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill 压缩包文件大小异常：${entry.entryName}`);
    bytes += size;
    if (bytes > MAX_SKILL_BYTES) throw new Error('Skill 压缩包解压后大小超过 50 MB');
  }
}

export class SkillManager {
  readonly #userRoot: string;
  readonly #projectBaseRoot: string;
  readonly #approvalPath: string;
  readonly #requireApprovalForDiscovered: boolean;
  #workspaceRoot: string;
  #workspaceRootId = 'project';
  #approvals: Record<string, string>;
  #skills = new Map<string, ParsedSkill>();

  constructor(options: { userRoot: string; projectRoot: string; requireApprovalForDiscovered?: boolean }) {
    this.#userRoot = options.userRoot;
    this.#projectBaseRoot = resolve(options.projectRoot);
    this.#workspaceRoot = join(this.#projectBaseRoot, '.openlab', 'skills');
    this.#approvalPath = join(this.#projectBaseRoot, '.openlab', 'skill-approvals.json');
    this.#requireApprovalForDiscovered = options.requireApprovalForDiscovered === true;
    this.#approvals = readJsonFile<Record<string, string>>(this.#approvalPath, {});
    mkdirSync(this.#userRoot, { recursive: true });
    mkdirSync(this.#workspaceRoot, { recursive: true });
    this.refresh();
  }

  setWorkspaceRoot(root: string, rootId: string): SkillDescriptor[] {
    this.#workspaceRoot = join(resolve(root), '.openlab', 'skills');
    this.#workspaceRootId = rootId;
    return this.refresh();
  }

  refresh(): SkillDescriptor[] {
    this.#skills.clear();
    this.scanRoot(this.#userRoot, 'user');
    this.scanRoot(this.#workspaceRoot, this.#workspaceRootId === 'project' ? 'project' : 'workspace', this.#workspaceRootId);
    return this.list();
  }

  list(): SkillDescriptor[] {
    return [...this.#skills.values()].map((skill) => structuredClone(skill.descriptor));
  }

  load(id: string): ContextContribution {
    const skill = this.#skills.get(id);
    if (!skill) throw new Error(`Skill 不存在：${id}`);
    if (!skill.descriptor.enabled) throw new Error(`Skill 尚未批准或文件哈希已变化：${id}`);
    return {
      id: `skill:${skill.descriptor.id}`,
      label: `Skill · ${skill.descriptor.name}`,
      category: 'agent',
      priority: 820,
      content: skill.instructions,
      trust: 'trusted',
      sourceRefs: [skill.descriptor.id],
      cache: 'stable',
    };
  }

  match(text: string): SkillDescriptor[] {
    const normalized = text.toLocaleLowerCase();
    return this.list().filter((skill) => skill.enabled && (
      normalized.includes(skill.name.toLocaleLowerCase()) ||
      skill.description.toLocaleLowerCase().split(/\s+/u).filter((word) => word.length >= 3).some((word) => normalized.includes(word))
    ));
  }

  install(sourcePath: string, scope: 'user' | 'project'): SkillDescriptor[] {
    const targetRoot = scope === 'user' ? this.#userRoot : this.#workspaceRoot;
    mkdirSync(targetRoot, { recursive: true });
    const source = resolve(sourcePath);
    if (!existsSync(source)) throw new Error(`Skill 来源不存在：${sourcePath}`);
    const sourceStat = statSync(source);
    if (!sourceStat.isDirectory() && !source.toLocaleLowerCase().endsWith('.zip')) throw new Error('Skill 仅支持本地目录或 ZIP 压缩包');
    const targetName = sourceStat.isDirectory() ? basename(source) : basename(source, '.zip');
    const destination = join(targetRoot, targetName.replace(/[^a-zA-Z0-9._-]/gu, '-'));
    if (existsSync(destination)) throw new Error(`Skill 安装目标已存在：${basename(destination)}`);
    mkdirSync(destination, { recursive: false });
    try {
      if (sourceStat.isDirectory()) {
        auditSkillTree(source);
        cpSync(source, destination, { recursive: true, force: false });
      } else {
        const zip = new AdmZip(source);
        validateSkillZip(zip, destination);
        zip.extractAllTo(destination, false);
      }
      auditSkillTree(destination);
      let installed = this.refresh().filter((skill) => within(destination, skill.rootPath));
      if (installed.length === 0) throw new Error('Skill 包中没有可加载的 SKILL.md，或其 frontmatter/reference 校验失败');
      if (!this.#requireApprovalForDiscovered) {
        for (const skill of installed) if (skill.sha256) this.approve(skill.id, skill.sha256);
        installed = this.refresh().filter((skill) => within(destination, skill.rootPath));
      }
      return installed;
    } catch (error) {
      if (existsSync(destination) && within(targetRoot, destination)) rmSync(destination, { recursive: true, force: true });
      this.refresh();
      throw error;
    }
  }

  scaffoldProject(input: { id: string; name: string; description: string; instructions: string }): SkillDescriptor {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(input.id)) throw new Error('Skill ID 格式不合法');
    mkdirSync(this.#workspaceRoot, { recursive: true });
    const root = join(this.#workspaceRoot, input.id);
    if (existsSync(root)) throw new Error(`Skill 已存在：${input.id}`);
    mkdirSync(root, { recursive: false });
    const frontmatter = YAML.stringify({ id: input.id, name: input.name, description: input.description, enabled: true });
    atomicWriteText(join(root, 'SKILL.md'), `---\n${frontmatter}---\n\n${input.instructions.trim()}\n`);
    this.refresh();
    let descriptor = this.list().find((skill) => skill.id === input.id || skill.rootPath === root);
    if (!descriptor) throw new Error('Skill 脚手架创建后未能加载');
    if (descriptor.sha256) {
      this.approve(descriptor.id, descriptor.sha256);
      this.refresh();
      descriptor = this.list().find((skill) => skill.id === input.id || skill.rootPath === root);
    }
    if (!descriptor) throw new Error('Skill 脚手架批准后未能加载');
    return descriptor;
  }

  approve(id: string, sha256: string): SkillDescriptor {
    const skill = this.#skills.get(id);
    if (!skill || skill.descriptor.sha256 !== sha256) throw new Error('Skill 不存在或 SHA-256 已变化');
    this.#approvals[this.approvalKey(skill.descriptor)] = sha256;
    atomicWriteJson(this.#approvalPath, this.#approvals);
    this.refresh();
    const approved = this.#skills.get(id)?.descriptor;
    if (!approved) throw new Error('Skill 批准后未能重新加载');
    return structuredClone(approved);
  }

  fingerprint(id: string): string {
    const skill = this.#skills.get(id);
    if (!skill) throw new Error(`Skill 不存在：${id}`);
    return createHash('sha256').update(skill.instructions).digest('hex');
  }

  private scanRoot(root: string, scope: 'user' | 'project' | 'workspace', rootId?: string): void {
    if (!existsSync(root)) return;
    const candidates = discoverSkillDirectories(root);
    for (const directory of candidates) {
      try {
        const path = join(directory, 'SKILL.md');
        if (!existsSync(path)) continue;
        const realDirectory = realpathSync(directory);
        const realSkillPath = realpathSync(path);
        if (!within(realDirectory, realSkillPath) || !statSync(realSkillPath).isFile() || statSync(realSkillPath).size > 1_000_000) throw new Error('SKILL.md 无效、越界或超过 1 MB');
        const content = readFileSync(realSkillPath, 'utf8');
        const { metadata, body } = parseFrontmatter(content);
        const fallbackName = basename(directory) === basename(root) ? basename(dirname(path)) : basename(directory);
        const name = typeof metadata.name === 'string' ? metadata.name : fallbackName;
        const description = typeof metadata.description === 'string' ? metadata.description : body.split(/\r?\n/u).find((line) => line.trim())?.replace(/^#+\s*/u, '') ?? name;
        const id = typeof metadata.id === 'string' ? metadata.id : `${scope}:${basename(directory)}`;
        if (!/^[a-z0-9][a-z0-9._:-]{1,127}$/u.test(id) || !name.trim() || name.length > 200 || !description.trim() || description.length > 1_000) throw new Error('Skill ID、名称或描述无效');
        const references = loadReferences(directory, metadata.references);
        const instructions = [body.trim(), ...references.content].filter(Boolean).join('\n\n');
        const sha256 = createHash('sha256').update(instructions).digest('hex');
        const approvalKey = `${scope}:${rootId ?? 'user'}:${id}`;
        const approvedSha256 = this.#approvals[approvalKey];
        const approvalRequired = this.#requireApprovalForDiscovered && approvedSha256 !== sha256;
        this.#skills.set(id, {
          descriptor: {
            id, name, description, rootPath: directory, scope,
            ...(rootId ? { rootId } : {}), sha256, ...(approvedSha256 ? { approvedSha256 } : {}), approvalRequired,
            allowedTools: normalizeAllowedTools(metadata['allowed-tools'] ?? metadata.allowedTools),
            references: references.paths,
            enabled: metadata.enabled !== false && !approvalRequired,
          },
          instructions,
        });
      } catch { /* malformed or escaping Skills remain inactive */ }
    }
  }

  private approvalKey(descriptor: SkillDescriptor): string {
    return `${descriptor.scope}:${descriptor.rootId ?? 'user'}:${descriptor.id}`;
  }
}
