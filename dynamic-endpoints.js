const fs = require('fs');
const path = require('path');

const LOCAL_FILE = path.join(__dirname, 'dynamic-endpoints-data.json');
const CLUSTER_FILE = '/contract/contract_fs/seed/state/dynamic-endpoints-data.json';

let useCluster = false;
let endpoints = [];

function loadFromDisk() {
  const fileToUse = useCluster ? CLUSTER_FILE : LOCAL_FILE;
  if (fs.existsSync(fileToUse)) {
    try {
      endpoints = JSON.parse(fs.readFileSync(fileToUse, 'utf8'));
    } catch (err) {
      console.error(`[dynamic-endpoints] Failed to parse ${fileToUse}:`, err);
      endpoints = [];
    }
  } else {
    endpoints = [];
  }
}

function saveToDisk() {
  if (useCluster) return; // prevent writes to cluster copy
  try {
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(endpoints, null, 2));
  } catch (err) {
    console.error('[dynamic-endpoints] Failed to save local endpoints:', err);
  }
}

function getEndpoints(explicitPath) {
  const filePath = explicitPath
    ? path.resolve(explicitPath) // <- FIX here
    : (
        useCluster
          ? '/contract/contract_fs/seed/state/dynamic-endpoints-data.json'
          : path.resolve(__dirname, 'dynamic-endpoints-data.json')
      );

  try {
    delete require.cache[require.resolve(filePath)];
    return require(filePath);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      console.warn(`[ENDPOINTS] File not found: ${filePath}. Returning empty list.`);
      return [];
    }
    throw err;
  }
}

function addEndpoint({ path, code, method, auth = false }) {
  const existing = endpoints.find(e => e.path === path && e.method === method.toLowerCase());
  if (existing) throw new Error(`Endpoint ${method.toUpperCase()} ${path} already exists.`);
  endpoints.push({ method: method.toLowerCase(), path, code, auth: !!auth });
  saveToDisk();
}

function editEndpoint({ method = 'get', path, code, auth }) {
  const m = method.toLowerCase();
  const i = endpoints.findIndex(e => e.path === path && e.method === m);
  if (i === -1) throw new Error(`Endpoint ${method.toUpperCase()} ${path} not found.`);
  endpoints[i].code = code;
  if (typeof auth !== 'undefined') endpoints[i].auth = !!auth;
  saveToDisk();
}

function removeEndpoint(method, path) {
  const m = method.toLowerCase();
  const i = endpoints.findIndex(e => e.path === path && e.method === m);
  if (i === -1) throw new Error(`Endpoint ${method.toUpperCase()} ${path} not found.`);
  endpoints.splice(i, 1);
  saveToDisk();
}

function setUseCluster(flag) {
  useCluster = flag;
  loadFromDisk();
}
function getUseCluster() {
  return useCluster;
}
loadFromDisk();

module.exports = {
  getEndpoints,
  addEndpoint,
  editEndpoint,
  removeEndpoint,
  setUseCluster,
  getUseCluster
};