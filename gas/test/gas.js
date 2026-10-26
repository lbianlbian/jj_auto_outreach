// Load src/*.js the way Apps Script does: every file in one shared global scope.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const strict = require('node:assert/strict');

const SRC = path.join(__dirname, '..', 'src');

/** A fresh copy of the Apps Script globals. gas.fetchLeads, gas.SCHEMA, etc. */
function loadGas() {
  const context = vm.createContext({console: {log() {}, warn() {}, error: console.error}});
  for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, {filename: file});
  }
  // Top-level const/class aren't properties of the context, so look names up by evaluating them.
  return new Proxy({}, {get: (_, name) => vm.runInContext(String(name), context)});
}

/** Objects made inside the vm have its prototypes, which deepStrictEqual rejects; compare plain copies. */
const plain = value => JSON.parse(JSON.stringify(value));

/** node:assert/strict, but deepEqual compares plain copies so vm-made values can be checked directly. */
const assert = Object.assign(Object.create(strict), {
  deepEqual: (actual, expected, message) => strict.deepEqual(plain(actual), plain(expected), message),
});

module.exports = {loadGas, plain, assert};
