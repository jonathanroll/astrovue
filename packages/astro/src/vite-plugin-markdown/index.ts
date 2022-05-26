import { transform } from '@astrojs/compiler';
import { renderMarkdown } from '@astrojs/markdown-remark';
import ancestor from 'common-ancestor-path';
import esbuild from 'esbuild';
import fs from 'fs';
import matter from 'gray-matter';
import { fileURLToPath } from 'url';
import type { Plugin } from 'vite';
import type { AstroConfig } from '../@types/astro';
import { pagesVirtualModuleId } from '../core/app/index.js';
import { prependForwardSlash } from '../core/path.js';
import { resolvePages, viteID } from '../core/util.js';
import { PAGE_SSR_SCRIPT_ID } from '../vite-plugin-scripts/index.js';
import { getFileInfo } from '../vite-plugin-utils/index.js';

interface AstroPluginOptions {
	config: AstroConfig;
}

const MARKDOWN_IMPORT_FLAG = '?mdImport';
const MARKDOWN_CONTENT_FLAG = '?content';

// TODO: Clean up some of the shared logic between this Markdown plugin and the Astro plugin.
// Both end up connecting a `load()` hook to the Astro compiler, and share some copy-paste
// logic in how that is done.
export default function markdown({ config }: AstroPluginOptions): Plugin {
	function normalizeFilename(filename: string) {
		if (filename.startsWith('/@fs')) {
			filename = filename.slice('/@fs'.length);
		} else if (filename.startsWith('/') && !ancestor(filename, config.root.pathname)) {
			filename = new URL('.' + filename, config.root).pathname;
		}
		return filename;
	}

	// Weird Vite behavior: Vite seems to use a fake "index.html" importer when you
	// have `enforce: pre`. This can probably be removed once the vite issue is fixed.
	// see: https://github.com/vitejs/vite/issues/5981
	const fakeRootImporter = fileURLToPath(new URL('index.html', config.root));
	function isRootImport(importer: string | undefined) {
		if (!importer) {
			return true;
		}
		if (importer === fakeRootImporter) {
			return true;
		}
		if (importer === '\0' + pagesVirtualModuleId) {
			return true;
		}
		return false;
	}

	return {
		name: 'astro:markdown',
		enforce: 'pre',
		async resolveId(id, importer, options) {
			// Resolve any .md files with the `?content` cache buster. This should only come from
			// an already-resolved JS module wrapper. Needed to prevent infinite loops in Vite.
			// Unclear if this is expected or if cache busting is just working around a Vite bug.
			if (id.endsWith(`.md${MARKDOWN_CONTENT_FLAG}`)) {
				const resolvedId = await this.resolve(id, importer, { skipSelf: true, ...options });
				return resolvedId?.id.replace(MARKDOWN_CONTENT_FLAG, '');
			}
			// If the markdown file is imported from another file via ESM, resolve a JS representation
			// that defers the markdown -> HTML rendering until it is needed. This is especially useful
			// when fetching and then filtering many markdown files, like with import.meta.glob() or Astro.glob().
			// Otherwise, resolve directly to the actual component.
			if (id.endsWith('.md') && !isRootImport(importer)) {
				const resolvedId = await this.resolve(id, importer, { skipSelf: true, ...options });
				if (resolvedId) {
					return resolvedId.id + MARKDOWN_IMPORT_FLAG;
				}
			}
			// In all other cases, we do nothing and rely on normal Vite resolution.
			return undefined;
		},
		async load(id) {
			// A markdown file has been imported via ESM!
			// Return the file's JS representation, including all Markdown
			// frontmatter and a deferred `import() of the compiled markdown content.
			if (id.endsWith(`.md${MARKDOWN_IMPORT_FLAG}`)) {
				const { fileId, fileUrl } = getFileInfo(id, config);

				const source = await fs.promises.readFile(fileId, 'utf8');
				const { data: frontmatter } = matter(source);
				return {
					code: `
						// Static
						export const frontmatter = ${JSON.stringify(frontmatter)};
						export const file = ${JSON.stringify(fileId)};
						export const url = ${JSON.stringify(fileUrl)};

						export function $$loadMetadata() {
							return load().then((m) => m.$$metadata)
						}
						
						// Deferred
						export default async function load() {
							return (await import(${JSON.stringify(fileId + MARKDOWN_CONTENT_FLAG)}));
						};
						export function Content(...args) {
							return load().then((m) => m.default(...args))
						}
						Content.isAstroComponentFactory = true;
						export function getHeaders() {
							return load().then((m) => m.metadata.headers)
						};`,
					map: null,
				};
			}

			// A markdown file is being rendered! This markdown file was either imported
			// directly as a page in Vite, or it was a deferred render from a JS module.
			// This returns the compiled markdown -> astro component that renders to HTML.
			if (id.endsWith('.md')) {
				const filename = normalizeFilename(id);
				const source = await fs.promises.readFile(filename, 'utf8');
				const renderOpts = config.markdown;

				const fileUrl = new URL(`file://${filename}`);
				const isPage = fileUrl.pathname.startsWith(resolvePages(config).pathname);
				const hasInjectedScript = isPage && config._ctx.scripts.some((s) => s.stage === 'page-ssr');

				// Extract special frontmatter keys
				let { data: frontmatter, content: markdownContent } = matter(source);

				// Turn HTML comments into JS comments
				markdownContent = markdownContent.replace(
					/<\s*!--([^-->]*)(.*?)-->/gs,
					(whole) => `{/*${whole}*/}`
				);

				let renderResult = await renderMarkdown(markdownContent, {
					...renderOpts,
					fileURL: fileUrl,
				} as any);
				let { code: astroResult, metadata } = renderResult;
				const { layout = '', components = '', setup = '', ...content } = frontmatter;
				content.astro = metadata;
				const prelude = `---
import { slug as $$slug } from '@astrojs/markdown-remark';
${layout ? `import Layout from '${layout}';` : ''}
${components ? `import * from '${components}';` : ''}
${hasInjectedScript ? `import '${PAGE_SSR_SCRIPT_ID}';` : ''}
${setup}

const $$content = ${JSON.stringify(content)}
---`;
				const imports = `${layout ? `import Layout from '${layout}';` : ''}
${setup}`.trim();
				// If the user imported "Layout", wrap the content in a Layout
				if (/\bLayout\b/.test(imports)) {
					astroResult = `${prelude}\n<Layout content={$$content}>\n\n${astroResult}\n\n</Layout>`;
				} else {
					astroResult = `${prelude}\n${astroResult}`;
				}

				// Transform from `.astro` to valid `.ts`
				let { code: tsResult } = await transform(astroResult, {
					pathname: '/@fs' + prependForwardSlash(fileUrl.pathname),
					projectRoot: config.root.toString(),
					site: config.site ? new URL(config.base, config.site).toString() : undefined,
					sourcefile: id,
					sourcemap: 'inline',
					// TODO: baseline flag
					experimentalStaticExtraction: true,
					internalURL: `/@fs${prependForwardSlash(
						viteID(new URL('../runtime/server/index.js', import.meta.url))
					)}`,
				});

				tsResult = `\nexport const metadata = ${JSON.stringify(metadata)};
export const frontmatter = ${JSON.stringify(content)};
${tsResult}`;

				// Compile from `.ts` to `.js`
				const { code } = await esbuild.transform(tsResult, {
					loader: 'ts',
					sourcemap: false,
					sourcefile: id,
				});
				return {
					code,
					map: null,
				};
			}

			return null;
		},
	};
}
