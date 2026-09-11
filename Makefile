
.PHONY: test

all: format check

format: prettier

check: pyright checkprettier test-payments test-server


prettier:
	uv run ./node_modules/.bin/prettier --write .

pyright:
	uv run ./node_modules/.bin/pyright

checkprettier:
	uv run ./node_modules/.bin/prettier --check .


checkblack:
	echo "Does not apply, skipping."

checkruff:
	echo "Does not apply, skipping."

checkbundle:
	echo "Does not apply, skipping."

mypy:
	echo "Does not apply, skipping."

.PHONY: test-payments
test-payments:
	node --check server.mjs
	node payments.test.mjs
	node incoming.test.mjs

.PHONY: test-server
test-server:
	node server.test.mjs
