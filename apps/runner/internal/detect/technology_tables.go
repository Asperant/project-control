package detect

// techRef is one entry in a dependency/package-name → technology lookup
// table. Version is intentionally never set from these tables: a dependency
// name only proves presence, not a safely-derived version.
type techRef struct {
	Name     string
	Category string
}

// npmDependencyTechnology maps a package.json dependency name (dependencies
// or devDependencies) to the technology it is evidence for. Deliberately not
// exhaustive — this is a best-effort signal list, not a registry mirror.
var npmDependencyTechnology = map[string]techRef{
	"react":         {"React", "framework"},
	"react-dom":     {"React", "framework"},
	"next":          {"Next.js", "framework"},
	"vue":           {"Vue", "framework"},
	"nuxt":          {"Nuxt", "framework"},
	"@angular/core": {"Angular", "framework"},
	"svelte":        {"Svelte", "framework"},
	"express":       {"Express", "framework"},
	"fastify":       {"Fastify", "framework"},
	"@nestjs/core":  {"NestJS", "framework"},
	"koa":           {"Koa", "framework"},

	"vite":    {"Vite", "build_tool"},
	"webpack": {"Webpack", "build_tool"},
	"esbuild": {"esbuild", "build_tool"},
	"rollup":  {"Rollup", "build_tool"},
	"turbo":   {"Turborepo", "build_tool"},

	"eslint":   {"ESLint", "other"},
	"prettier": {"Prettier", "other"},

	"jest":             {"Jest", "test_tool"},
	"vitest":           {"Vitest", "test_tool"},
	"mocha":            {"Mocha", "test_tool"},
	"playwright":       {"Playwright", "test_tool"},
	"@playwright/test": {"Playwright", "test_tool"},
	"cypress":          {"Cypress", "test_tool"},

	"pg":             {"PostgreSQL", "database"},
	"postgres":       {"PostgreSQL", "database"},
	"mysql2":         {"MySQL", "database"},
	"mysql":          {"MySQL", "database"},
	"mongodb":        {"MongoDB", "database"},
	"mongoose":       {"MongoDB", "database"},
	"redis":          {"Redis", "database"},
	"ioredis":        {"Redis", "database"},
	"sqlite3":        {"SQLite", "database"},
	"better-sqlite3": {"SQLite", "database"},

	"prisma":         {"Prisma", "other"},
	"@prisma/client": {"Prisma", "other"},
	"tailwindcss":    {"Tailwind CSS", "other"},
}

// pyPackageTechnology maps a Python package name (as it appears in
// requirements.txt or a pyproject.toml dependency list) to a technology.
var pyPackageTechnology = map[string]techRef{
	"django":          {"Django", "framework"},
	"flask":           {"Flask", "framework"},
	"fastapi":         {"FastAPI", "framework"},
	"pytest":          {"pytest", "test_tool"},
	"psycopg2":        {"PostgreSQL", "database"},
	"psycopg2-binary": {"PostgreSQL", "database"},
	"psycopg":         {"PostgreSQL", "database"},
	"pymongo":         {"MongoDB", "database"},
	"redis":           {"Redis", "database"},
	"sqlalchemy":      {"SQLAlchemy", "other"},
	"numpy":           {"NumPy", "other"},
	"pandas":          {"pandas", "other"},
	"celery":          {"Celery", "other"},
}

// composeImageDatabase maps a substring found in a compose `image:` value to
// the database technology it indicates.
var composeImageDatabase = map[string]string{
	"postgres":   "PostgreSQL",
	"postgresql": "PostgreSQL",
	"mysql":      "MySQL",
	"mariadb":    "MariaDB",
	"mongo":      "MongoDB",
	"redis":      "Redis",
}
