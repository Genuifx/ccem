# Portable test paths and symlinks

These test-only helpers address two recurring cross-platform mistakes: Node ESM
cannot import a raw Windows drive path, and `read_link` can return a native Windows
path while a fixture created by `canonicalize` uses a verbatim prefix.

## JavaScript fixtures

Import `fixturePath` and `importFixture` from
`apps/desktop/test/helpers/fixture-paths.mjs` (usually `./helpers/fixture-paths.mjs`
from a desktop test).

```js
const source = fixturePath(import.meta.url, '../src/example.ts');
const fixture = await importFixture(outfile);
```

`fixturePath` decodes the importing module URL before resolving filesystem path
segments. `importFixture` converts the filename to a file URL before importing it.
Spaces, Unicode, `%` and `#` keep their filesystem meaning. Neither helper performs
containment validation, changes the working directory, or bypasses the module
cache. Existing `pathToFileURL(...).href` imports and intentional data URLs remain
valid; use the shared helper for new ordinary file fixtures. Cache-busting tests
can retain their explicitly escaped URL plus query suffix.

## Rust symlink fixtures

`crate::test_support` is compiled only for tests and provides:

- `symlink_file(source, link)` and `symlink_dir(source, link)`: choose the kind
  explicitly, including for missing targets. Errors are returned, never silently
  skipped on Windows; the runner still needs symlink creation privileges.
- `assert_symlink_target(link, expected)`: requires an actual link, reads its stored
  target, and permits only the Windows native/verbatim disk or UNC prefix
  difference. The helper is independent of the production link comparator.

The assertion does **not** canonicalize, follow a target, collapse `..`, case-fold,
strip arbitrary prefixes, or establish that a link is safe. It works for dangling
links. Keep all separate traversal, containment, forbidden-file, and cycle
assertions. Production link creation/removal tests should still call the production
functions they exercise.

For an archive format or other literal spelling contract, exact `read_link`
equality is intentional. Preserve it with a local, reasoned exception rather than
weakening the assertion:

```rust
// test-path-allow: rust-link-target -- Archive contract requires the exact declared relative target.
assert_eq!(fs::read_link(link).unwrap(), PathBuf::from("Browser"));
```

## Narrow source guard

Run `pnpm check:test-paths` and `pnpm test:test-paths` (also included in CI).
The guard checks tracked and untracked, non-ignored Rust files, JavaScript/TypeScript `.test.*` and `.spec.*` files (including TSX),
and JavaScript test helpers. It intentionally is not a general linter or a security
proof:

- JavaScript syntax is parsed, so comments and embedded fixture source are not
  mistaken for imports. Raw dynamic filesystem imports must use the helper;
  static package/relative imports, escaped file URLs and data URLs remain valid.
- Rust direct `assert_eq!`/`assert_ne!` operands that are `read_link` results
  (optionally unwrapped with `unwrap` or `expect`) must use the helper. Link
  snapshots, error/boolean security checks, and production operations are
  unaffected. The guard does not trace values through variables or inspect
  every assertion style.
- An immediately preceding `// test-path-allow: RULE -- reason` exempts one
  operation. Allowed rule names are `rust-link-target` and `esm-fixture-import`.
  Explain the semantic contract that needs the exception. A blanket file exemption
  or a marker without a reason does not suppress findings.

The helper tests use real filesystem fixtures with reserved URL characters.
Rust tests cover file/directory and dangling links, wrong targets and ordinary
files; Windows-only cases cover disk and UNC prefix equivalence and non-equivalent
paths. The repository's Windows Rust job remains necessary to exercise those
platform-specific cases.
