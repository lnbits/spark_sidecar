
.PHONY: test

all: format check

format: prettier

check: pyright checkprettier


prettier:
	uv run ./node_modules/.bin/prettier --write .

pyright:
	uv run ./node_modules/.bin/pyright

checkprettier:
	uv run ./node_modules/.bin/prettier --check .
