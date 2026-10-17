# 3DM Catalog Asset

Catalog source for EMMM. It contains canonical identities, aliases, hashes,
metadata, validated runtime targets for KeyViewer, and bounded avatar assets.
It contains no executable code, plugin, DLL, or automatic upstream sync.
**This catalog is not the EMMM mod manager or a mod.** Get EMMM from
[the EMMM2 repository](https://github.com/reynalivan/EMMM2).

## Install the catalog in EMMM

1. Install and open EMMM.
2. In EMMM, open **Settings > Catalog Assets**.
3. Under **Install from ZIP**, choose **Choose ZIP** and select the downloaded
   `catalog-pack.zip`. Review the version, publisher, supported games, and
   entry count, then select **Install pack**.

Do not extract `catalog-pack.zip` into your Mods folder. The original ZIP
stays where you saved it. Installing a pack replaces the active catalog only
after you confirm the review screen. EMMM can also check the official GitHub
release channel for catalog updates from the same Settings page.

## Roster, equipment, and thumbnail metadata

`sync-wiki-catalog.mjs` refreshes playable-character and equipment entries from
the maintained Fandom list pages for GIMI, SRMI, WWMI, and ZZMI. It preserves
existing aliases, hashes, skins, and reviewed runtime targets while refreshing
release, role, combat, and equipment metadata.

```powershell
node ./scripts/sync-wiki-catalog.mjs check
node ./scripts/sync-wiki-catalog.mjs update
```

`check` reports the source counts without changing catalog files. `update`
writes the synchronized catalog files and refreshes their manifest checksums;
it deliberately leaves the release version unchanged. Set and review the
SemVer version before running the release command.

Entries may include Fandom thumbnail source metadata (`thumbnail_url`,
`thumbnail_file`, and `thumbnail_source_page`). `update` downloads the
validated original-size image into
`assets/<game>/characters/` or `assets/<game>/weapons/` and
records its relative path and SHA-256. The downloader removes Fandom's resize
parameters, requires a minimum 150 × 150 px image, bounds it to 2 MiB, accepts
PNG/JPEG/WebP/GIF, and includes it in a signed release. Run `avatars` to retry
only missing or changed avatar assets.

EFMI is not covered by that four-game sync script. Its current operator names
are checked against the [official operator roster](https://endfield.gryphline.com/en-us/operator)
and added only as name-based catalog entries until hashes, metadata, or images
can be verified. Existing historical entries remain in the catalog.

```powershell
node ./scripts/sync-wiki-catalog.mjs avatars
node ./scripts/validate-catalog-identities.mjs --require-assets
```

## Maintainer metadata snapshots

Runtime target discovery is a maintainer workflow, not an end-user update.
Pinned upstream repositories live in `scripts/upstream-sources.json`; canonical
mapping is deliberately explicit in `scripts/runtime-target-mapping.json`.

```powershell
node ./scripts/maintain-runtime-targets.mjs check
node ./scripts/maintain-runtime-targets.mjs update
node ./scripts/promote-runtime-targets.mjs
```

`check` reads the pinned upstream metadata without writing it locally and
reports inventory, checksums, empty target sets, 16-hex shader targets,
ambiguous typed hashes, and missing explicit mappings. `update` downloads only
allowlisted JSON metadata into a new immutable
`metadata-snapshots/generations/<id>/` candidate and atomically advances
`metadata-snapshots/current.json` only after every download and report is
complete. It also emits a `runtime-targets-v2.json` candidate with typed
resource kind, callback slot when known, index-buffer draw context, and
provenance. The candidate is not a published pack; `update` never changes
catalog entries, downloads models/textures, executes upstream scripts, signs a
release, or publishes anything. Unmapped candidates must be reviewed and
mapped explicitly before becoming a v2 `runtime_targets` entry.

`runtime-target-mapping.json` is intentionally path-based. Each mapping names
the game, pinned metadata path prefix, canonical catalog identity, and variant;
optional `component` or `component_by_source_key` fields may refine generated
targets. Never infer an identity from a similar folder name.

## Combined source refresh

Use one command to refresh Wiki metadata and inspect the four upstream hash
repositories together:

```powershell
node ./scripts/refresh-catalog-sources.mjs check
node ./scripts/refresh-catalog-sources.mjs update
```

The command reports the current GitHub branch head alongside each pinned
commit, synchronizes Wiki roster/equipment data, and reads only allowlisted
upstream metadata files. `update` atomically refreshes each catalog and runtime
snapshot, but it never changes `upstream-sources.json`, promotes a hash,
downloads models or images, signs, or publishes a release. When a source head
has advanced, review its metadata and explicitly update the pin before using it
for a later snapshot.

## End-user updates

EMMM checks the public GitHub Releases channel anonymously. It never needs a
user GitHub account, token, or credential. A release is accepted only when its
`catalog-pack.zip` asset matches `catalog-pack.sig`, an Ed25519 signature over
the ZIP bytes. EMMM verifies that signature before extracting the archive.

Publish exactly these two release assets:

- `catalog-pack.zip`
- `catalog-pack.sig`

Use a stable SemVer release tag such as `v1.2.0`. Its version must exactly
match `manifest.json` (for example `"version": "1.2.0"`). Release notes should
briefly list added or corrected entries and hashes.

`promote-runtime-targets.mjs` consumes the reviewed current snapshot, writes
targets only for explicitly mapped identities, ensures every catalog entry has
a `runtime_targets` array, removes thumbnail references, and refreshes catalog
checksums. It never downloads images or guesses mappings.

## Maintaining the source

`manifest.json`, `catalog/`, and bounded `assets/<game>/` directories are included in a
catalog release. `manifest.json` declares each catalog file hash; each avatar
is bound by a SHA-256 recorded in its entry metadata. Do not add scripts,
archives, executables, SVGs, or source-only notes to the release ZIP.

The release gate requires runtime targets, exact checksums, and safe archive
contents. Release signatures establish the trusted EMMM update channel.

## Signing a release

The maintainer-only signing key is deliberately ignored by Git at
`.keys/catalog-update-ed25519.pem`. Back it up in an encrypted password manager
or secret store, then configure the same key as a protected CI secret if
releases are automated. Never commit, upload, or paste the private key into
issues, release notes, or EMMM.

For a new catalog channel, create the key once with:

```powershell
node ./scripts/New-CatalogSigningKey.mjs
```

It prints only the public verification key. Pin that value in an EMMM release
before publishing any signed catalog release. Do not rotate the key casually:
older EMMM builds cannot verify a new key.

From PowerShell, build a release with:

```powershell
./scripts/New-CatalogRelease.ps1 -Version 1.2.0
```

Add `-VersionedOutput` to write `dist/<version>/catalog-pack.zip` and
`dist/<version>/catalog-pack.sig` while preserving earlier local builds.

The command validates the manifest schema, creates `dist/catalog-pack.zip`,
and writes `dist/catalog-pack.sig`. Inspect the ZIP contents before uploading
both files to a non-draft, non-prerelease GitHub Release.

The public verification key is pinned in EMMM. Replacing the private key
requires an EMMM release that pins the new public key before catalog releases
using it are published.
