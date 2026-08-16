import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type AuthorizedPathErrorCode =
  | 'EMPTY_PATH'
  | 'PATH_NOT_FOUND'
  | 'PATH_UNAVAILABLE'
  | 'NOT_A_DIRECTORY'
  | 'ABSOLUTE_PATH'
  | 'OUTSIDE_AUTHORIZED_ROOT'
  | 'UNSAFE_SYMLINK';

export class AuthorizedPathError extends Error {
  readonly code: AuthorizedPathErrorCode;
  readonly path: string;

  constructor(code: AuthorizedPathErrorCode, message: string, path: string) {
    super(message);
    this.name = 'AuthorizedPathError';
    this.code = code;
    this.path = path;
  }
}

export interface AuthorizedRoot {
  readonly canonicalPath: string;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Turns an explicitly selected, existing directory into a canonical authorization root.
 * A symlink selected as the root is rejected; aliases in ancestor paths are canonicalized.
 */
export function authorizeExistingDirectory(inputPath: string): AuthorizedRoot {
  if (inputPath.trim().length === 0) {
    throw new AuthorizedPathError('EMPTY_PATH', '授权目录不能为空', inputPath);
  }

  const absolutePath = resolve(inputPath);
  try {
    if (!existsSync(absolutePath)) {
      throw new AuthorizedPathError('PATH_NOT_FOUND', '授权目录不存在', inputPath);
    }

    const selectedStat = lstatSync(absolutePath);
    if (selectedStat.isSymbolicLink()) {
      throw new AuthorizedPathError(
        'UNSAFE_SYMLINK',
        '授权目录不能是符号链接',
        inputPath,
      );
    }
    if (!selectedStat.isDirectory()) {
      throw new AuthorizedPathError('NOT_A_DIRECTORY', '授权路径不是目录', inputPath);
    }

    return Object.freeze({ canonicalPath: realpathSync.native(absolutePath) });
  } catch (error) {
    if (error instanceof AuthorizedPathError) throw error;
    throw new AuthorizedPathError(
      'PATH_UNAVAILABLE',
      '授权目录当前不可访问',
      inputPath,
    );
  }
}

/**
 * Resolves a declaration-owned relative path without allowing absolute paths,
 * traversal outside the authorization root, or symlink traversal.
 * Missing leaf paths are returned so callers can report their domain-specific error.
 */
export function resolveAuthorizedPath(
  root: AuthorizedRoot | string,
  configuredPath: string,
): string {
  if (isAbsolute(configuredPath)) {
    throw new AuthorizedPathError(
      'ABSOLUTE_PATH',
      '授权范围内的路径必须是相对路径',
      configuredPath,
    );
  }

  const authorization =
    typeof root === 'string' ? authorizeExistingDirectory(root) : root;
  const candidate = resolve(authorization.canonicalPath, configuredPath);

  if (!isInside(authorization.canonicalPath, candidate)) {
    throw new AuthorizedPathError(
      'OUTSIDE_AUTHORIZED_ROOT',
      '路径越过授权目录',
      configuredPath,
    );
  }

  try {
    const rel = relative(authorization.canonicalPath, candidate);
    let cursor = authorization.canonicalPath;
    for (const segment of rel === '' ? [] : rel.split(sep)) {
      cursor = resolve(cursor, segment);
      if (!existsSync(cursor)) {
        break;
      }
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new AuthorizedPathError(
          'UNSAFE_SYMLINK',
          '路径不能穿过符号链接',
          configuredPath,
        );
      }
    }

    if (existsSync(candidate)) {
      const canonicalCandidate = realpathSync.native(candidate);
      if (!isInside(authorization.canonicalPath, canonicalCandidate)) {
        throw new AuthorizedPathError(
          'OUTSIDE_AUTHORIZED_ROOT',
          '路径解析后越过授权目录',
          configuredPath,
        );
      }
    }
  } catch (error) {
    if (error instanceof AuthorizedPathError) throw error;
    throw new AuthorizedPathError(
      'PATH_UNAVAILABLE',
      '授权范围内的路径当前不可访问',
      configuredPath,
    );
  }

  return candidate;
}
