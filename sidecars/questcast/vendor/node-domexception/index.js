'use strict'
// The platform's native DOMException, which node-domexception's deprecation
// notice points to. It is a global in Node 17 and later and in every browser.
module.exports = globalThis.DOMException
