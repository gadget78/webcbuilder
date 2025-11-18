const https = require('https');
const fs = require('fs');
const fsp = require('fs').promises;
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const basicAuth = require('express-basic-auth');
const HotPocket = require('hotpocket-js-client');
const BSON = require('bson');
const crypto = require('crypto');
const app = express();
const rateLimit = require('express-rate-limit');
const vm = require('vm');
const axios = require('axios');
const mime = require('mime-types');
const settingsPath = path.join(__dirname, 'settings.json');
const HOTPOCKET_WS_URL = 'wss://localhost:26201';
const { exec } = require('child_process');
const adminRouter = express.Router();
const chokidar = require('chokidar');
const sslOptions = {
 key: fs.readFileSync('/contract/cfg/tlskey.pem'),
  cert: fs.readFileSync('/contract/cfg/tlscert.pem'),
};


function persistLoadedModules() {
  fs.writeFileSync(LOADED_MODULES_PATH, JSON.stringify(Object.keys(loadedModules), null, 2));
}
async function detectFileType(fullPath) {
  const { fromBuffer } = await import('file-type');
  const buffer = fs.readFileSync(fullPath);
  const type = await fromBuffer(buffer);
  return type;
}

app.use(cors());
app.use(bodyParser.json());

app.use((req, res, next) => {

  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    : { useCluster: false };

  const servePath = settings.useCluster
    ? '/contract/contract_fs/seed/state/public'
    : path.join(__dirname, 'public');

  express.static(servePath)(req, res, next);
});

function ensureAdmin(req, res) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return false;

  const base64 = auth.split(' ')[1];
  const [username] = Buffer.from(base64, 'base64').toString('utf-8').split(':');

  return username === 'admin';
}

const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skipSuccessfulRequests: true,
  message: 'Too many attempts, please try again later.',
  standardHeaders: true, 
  legacyHeaders: false, 
});

app.use('/admin', express.static(path.join(__dirname, 'admin')));
function getUploadSuffix() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  return `version-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let folder = req.headers['x-upload-folder'] || '';
    folder = decodeURIComponent(folder).trim();

    const safeFolder = path.normalize(folder).replace(/^([\.\/]+)+/, '').replace(/^(\.{2,})(\/|\|$)/, '');
    const folderPath = path.join(__dirname, 'public', safeFolder);
    console.log('Uploading to folder:', folderPath);

    fs.mkdirSync(folderPath, { recursive: true });
    cb(null, folderPath);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

function loadUserCredentials() {
  const hashFile = path.join(__dirname, 'password.hash');
  const credentials = {};

  if (fs.existsSync(hashFile)) {
    const lines = fs.readFileSync(hashFile, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed.includes(':')) {
        const [user, hash] = trimmed.split(':');
        credentials[user.trim()] = hash.trim();
      }
    }
  }

  return credentials;
}
function myAuthorizer(username, password) {
  const users = loadUserCredentials();
  const storedHash = users[username];

  if (!storedHash) return false;

  const inputHash = crypto.createHash('sha256').update(password).digest('hex');

 // console.log(`[AUTH DEBUG] username=${username}`);
 // console.log(`[AUTH DEBUG] expected=${storedHash}`);
 // console.log(`[AUTH DEBUG] received=${inputHash}`);

  return storedHash === inputHash;
}

const authMiddleware = basicAuth({
  authorizer: myAuthorizer,
  authorizeAsync: false,
  challenge: true
});

app.post('/admin/upload', adminRateLimiter, authMiddleware, upload.fields([{ name: 'files' }]), (req, res) => {
  const chunkNo = parseInt(req.body.chunkNo);
  const totalChunks = parseInt(req.body.totalChunks);
  const filename = req.body.filename;
  const uploadPath = decodeURIComponent(req.headers['x-upload-folder'] || '').trim();

  if (!filename || isNaN(chunkNo) || isNaN(totalChunks)) {
    return res.status(400).json({ error: 'Missing chunk metadata or filename.' });
  }

  const safeFolder = path.normalize(uploadPath).replace(/^([\.\/]+)+/, '');
  const tempDir = path.join(__dirname, 'uploads_temp', safeFolder, filename);

  fs.mkdirSync(tempDir, { recursive: true });

  const fileChunk = req.files['files']?.[0];
  if (!fileChunk) {
    return res.status(400).json({ error: 'No file chunk received.' });
  }

  const chunkPath = path.join(tempDir, `chunk_${chunkNo}`);
  fs.writeFileSync(chunkPath, fs.readFileSync(fileChunk.path));

  // Clean up multer temp file
  fs.unlinkSync(fileChunk.path);

  const chunks = fs.readdirSync(tempDir).filter(f => f.startsWith('chunk_'));

  if (chunks.length === totalChunks) {
    const finalDir = path.join(__dirname, 'public', safeFolder);
    fs.mkdirSync(finalDir, { recursive: true });

    const finalPath = path.join(finalDir, filename);
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 1; i <= totalChunks; i++) {
      const chunk = fs.readFileSync(path.join(tempDir, `chunk_${i}`));
      writeStream.write(chunk);
    }

    writeStream.end();
    fs.rmSync(tempDir, { recursive: true, force: true });

    return res.send({ message: `Upload of '${filename}' complete.` });
  }

  res.send({ message: `Chunk ${chunkNo}/${totalChunks} received.` });
});



const extraModules = {};

const EXTRA_MODULES_PATH = path.join(__dirname, 'extra-modules.json');

adminRouter.get('/modules/available', adminRateLimiter, authMiddleware, (req, res) => {
  const nodeModulesPath = path.join(__dirname, 'node_modules');
  const modules = [];

  fs.readdirSync(nodeModulesPath).forEach(name => {
    const fullPath = path.join(nodeModulesPath, name);
    if (name.startsWith('@')) {
      fs.readdirSync(fullPath).forEach(sub => {
        const scopedName = `${name}/${sub}`;
        const scopedPath = path.join(fullPath, sub);
        if (fs.statSync(scopedPath).isDirectory()) {
          modules.push(scopedName);
        }
      });
    } else {
      if (fs.statSync(fullPath).isDirectory()) {
        modules.push(name);
      }
    }
  });

  res.json({ available: modules });
});

console.log("Initial extraModules:", Object.keys(extraModules));

adminRouter.get('/modules/extra', adminRateLimiter, authMiddleware, (req, res) => {
  res.json({ extra: Object.keys(extraModules) });
});

adminRouter.post('/modules/extra', adminRateLimiter, authMiddleware, (req, res) => {
const { name } = req.body;

  if (!name) return res.status(400).json({ error: 'Module name required' });
  if (extraModules[name]) return res.json({ message: `${name} already loaded` });

  try {
    // Try resolving from the node_modules folder directly
    const resolvedPath = require.resolve(name, {
      paths: [path.join(__dirname, 'node_modules')],
    });

    const mod = require(resolvedPath);
    extraModules[name] = mod;
    saveExtraModules();

    res.json({ message: `${name} loaded`, keys: Object.keys(mod) });
  } catch (err) {
    res.status(500).json({ error: `Failed to load ${name}: ${err.message}` });
  }
});




if (fs.existsSync(EXTRA_MODULES_PATH)) {
  try {
    const moduleNames = JSON.parse(fs.readFileSync(EXTRA_MODULES_PATH, 'utf-8'));
    if (!Array.isArray(moduleNames)) {
      throw new Error('extra-modules.json must contain an array of module names');
    }

    for (const name of moduleNames) {
      try {
        global[name] = require(name);
        console.log(`Loaded module: ${name}`);
      } catch (err) {
        console.warn(`Could not load module "${name}": ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`Error reading extra modules: ${err.message}`);
  }
}

function saveExtraModules() {
  fs.writeFileSync(EXTRA_MODULES_PATH, JSON.stringify(Object.keys(extraModules), null, 2));
}


function reloadExtraModules() {
  try {
    const names = JSON.parse(fs.readFileSync(EXTRA_MODULES_PATH, 'utf-8'));
    const currentSet = new Set(names);

    for (const name of names) {
      try {
        const mod = require(name);
        extraModules[name] = mod;
        global[name] = mod;
        console.log(`Loaded or refreshed: ${name}`);
      } catch (err) {
        console.warn(`Failed to load module "${name}": ${err.message}`);
      }
    }

    for (const name of Object.keys(extraModules)) {
      if (!currentSet.has(name)) {
        delete extraModules[name];
        delete global[name];
        console.log(`Unloaded removed module: ${name}`);
      }
    }
  } catch (err) {
    console.error('Error reading extra modules file:', err.message);
  }
}


adminRouter.get('/vars/extra', adminRateLimiter, authMiddleware, (req, res) => {
  res.json({ extra: extraVars });
});

adminRouter.post('/vars/extra', adminRateLimiter, authMiddleware, (req, res) => {
  const { name, value } = req.body;

  if (!name) return res.status(400).json({ error: 'Variable name is required' });
  if (typeof value === 'undefined') return res.status(400).json({ error: 'Variable value is required' });

  extraVars[name] = value;
  global[name] = value;
  saveExtraVars();

  res.json({ message: `Variable "${name}" saved`, value });
});

adminRouter.delete('/vars/extra', adminRateLimiter, authMiddleware, (req, res) => {
  const { name } = req.body;

  if (!name) return res.status(400).json({ error: 'Variable name is required' });
  if (!extraVars[name]) return res.status(404).json({ error: `Variable "${name}" not found` });

  delete extraVars[name];
  delete global[name];
  saveExtraVars();

  res.json({ message: `Variable "${name}" deleted` });
});



const EXTRA_VARS_PATH = path.join(__dirname, 'extra-vars.json');
const extraVars = {};


if (fs.existsSync(EXTRA_VARS_PATH)) {
  try {
    const vars = JSON.parse(fs.readFileSync(EXTRA_VARS_PATH, 'utf-8'));
    if (typeof vars !== 'object' || Array.isArray(vars)) {
      throw new Error('extra-vars.json must contain an object of key-value pairs');
    }
    Object.entries(vars).forEach(([key, value]) => {
      extraVars[key] = value;
      global[key] = value;
    });
    console.log('Loaded extra vars:', Object.keys(extraVars));
  } catch (err) {
    console.error(`Error reading extra vars: ${err.message}`);
  }
}


function saveExtraVars() {
  fs.writeFileSync(EXTRA_VARS_PATH, JSON.stringify(extraVars, null, 2));
}


const dynamicRouter = express.Router();
const dynamicEndpoints = require('./dynamic-endpoints');
dynamicEndpoints.setUseCluster(false); 
registerDynamicRoutes(dynamicEndpoints.getEndpoints());


const deps = { exec, fs, axios, extraVars, HOTPOCKET_WS_URL, require };

function registerDynamicRoutes(routes) {
  const router = express.Router();

  for (const route of routes) {
    try {
      const handler = new Function('req', 'res', 'deps', `
        const { exec, fs, axios, extraVars, HOTPOCKET_WS_URL, require } = deps;

        (async () => {
          try {
            ${route.code}
          } catch (err) {
            console.error("Runtime error in handler:", err.stack || err);
            res.status(500).send("Internal Server Error");
          }
        })();
      `);

      const method = route.method.toLowerCase();
      const useAuth = route.auth === true;
      const boundHandler = (req, res) => handler(req, res, deps);

      if (typeof router[method] !== 'function') {
        console.error('Invalid HTTP method:', method);
        continue;
      }

      if (useAuth) {
        router[method](route.path, adminRateLimiter, authMiddleware, boundHandler);
      } else {
        router[method](route.path, boundHandler);
      }

      console.log(`Registered ${method.toUpperCase()} ${route.path}`);
    } catch (err) {
      console.error(`Failed to register ${route.method.toUpperCase()} ${route.path}:`, err.message);
    }
  }

  dynamicRouter.stack = router.stack;
}



const filesToWatch = [
  './dynamic-endpoints-data.json',
  '/contract/contract_fs/seed/state/dynamic-endpoints-data.json',
  '/contract/contract_fs/seed/state/dynamic-endpoints.json',
  './dynamic-endpoints.json',
  './extra-modules.json',
  '/contract/contract_fs/seed/state/extra-modules.json'
];

const EXTRA_MODULE_PATHS = new Set([
  path.resolve('./extra-modules.json'),
  path.resolve('/contract/contract_fs/seed/state/extra-modules.json')
]);

const reloadRoutes = (path) => {
  try {
    const routes = dynamicEndpoints.getEndpoints(path);
    registerDynamicRoutes(routes);
    console.log('[WATCHER] Routes reloaded');
  } catch (err) {
    console.error('[WATCHER] Route reload error:', err.message);
  }
};

const handleChange = (changedPath) => {
  const resolved = path.resolve(changedPath);

  console.log(`[WATCHER] File changed: ${resolved}`);

  if (EXTRA_MODULE_PATHS.has(resolved)) {
    reloadExtraModules();
    console.log(`[WATCHER] extra modules reloaded`);
  } else {
    reloadRoutes(resolved);
  }
};

const watcher = chokidar.watch(filesToWatch, {
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval: 500,
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100
  }
});

watcher
  .on('change', handleChange)
  .on('add', handleChange)
  .on('unlink', (path) => {
    console.warn(`[WATCHER] File removed: ${path}`);
  });




adminRouter.post('/set-api-mode', adminRateLimiter, authMiddleware, (req, res) => {
  const { useCluster } = req.body;
  try {
    dynamicEndpoints.setUseCluster(!!useCluster);
    registerDynamicRoutes(dynamicEndpoints.getEndpoints());
    res.json({ success: true });
   
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.use((req, res, next) => dynamicRouter(req, res, next));


adminRouter.post('/add-endpoint', adminRateLimiter, authMiddleware, (req, res) => {
  const { path, code, method, auth } = req.body;

  if (!path || !code || !method) {
    return res.status(400).json({ error: 'Path, method, and code are required.' });
  }

  try {
    dynamicEndpoints.addEndpoint({
      path,
      code,
      method: method.toLowerCase(),
      auth: !!auth
    });

    registerDynamicRoutes(dynamicEndpoints.getEndpoints());

    res.json({ message: `Endpoint ${method.toUpperCase()} ${path} added.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

adminRouter.get('/get-api-mode', adminRateLimiter, authMiddleware, (req, res) => {
  res.json({ useCluster: dynamicEndpoints.getUseCluster() });
});


adminRouter.get('/list-endpoints', adminRateLimiter, authMiddleware, (req, res) => {
  res.json(dynamicEndpoints.getEndpoints());
  registerDynamicRoutes(dynamicEndpoints.getEndpoints());
});

adminRouter.post('/edit-endpoint', adminRateLimiter, authMiddleware, (req, res) => {
  const { path, code, method, auth } = req.body;

  if (!path || !code || !method) {
    return res.status(400).json({ error: 'Path, method, and code are required.' });
  }

  try {
    dynamicEndpoints.editEndpoint({ path, code, method, auth });
    registerDynamicRoutes(dynamicEndpoints.getEndpoints());
    res.json({ message: `Endpoint ${method.toUpperCase()} ${path} updated.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function readSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(newSettings) {
  const current = readSettings();
  const merged = { ...current, ...newSettings };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
  return merged;
}

app.post('/toggle-morefunctions-source', adminRateLimiter, authMiddleware, (req, res) => {
  const { useCluster } = req.body;

  if (typeof useCluster !== 'boolean') {
    return res.status(400).json({ error: 'Invalid value for useCluster' });
  }

  const updated = writeSettings({ clusterMore: useCluster });
  res.json({ clusterMore: updated.clusterMore });
});

app.get('/toggle-morefunctions-source', adminRateLimiter, authMiddleware, (req, res) => {
  const current = readSettings();
  res.json({ clusterMore: !!current.clusterMore });
});


adminRouter.post('/delete-endpoint', adminRateLimiter, authMiddleware, (req, res) => {
  const { path, method } = req.body;

  if (!path || !method) {
    return res.status(400).json({ error: 'Path and method are required.' });
  }

  try {
    dynamicEndpoints.removeEndpoint(method, path);
    registerDynamicRoutes(dynamicEndpoints.getEndpoints());
    res.json({ message: `Endpoint ${method.toUpperCase()} ${path} deleted.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

adminRouter.post('/install', adminRateLimiter, authMiddleware, (req, res) => {
const { package, version } = req.body;
if (!package) return res.status(400).send('Package name is required');

const pkgWithVersion = version ? package + '@' + version : package;
exec('npm install ' + pkgWithVersion + ' --save --cache /home/everweb/npm-cache', (error, stdout, stderr) => {
  if (error) return res.status(500).send(stderr);
  res.send({ message: 'Installed ' + pkgWithVersion, output: stdout });
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});
});

adminRouter.post('/uninstall', adminRateLimiter, authMiddleware, (req, res) => {
const { package } = req.body;
if (!package) return res.status(400).send('Package name is required');

exec('npm uninstall ' + package + ' --save --cache /home/everweb/npm-cache', (error, stdout, stderr) => {
  if (error) return res.status(500).send(stderr);
  res.send({ message: 'Uninstalled ' + package, output: stdout });
});
});


const mfFile = path.join(__dirname, 'morefunctions.json');

app.get('/morefunctions/load', adminRateLimiter, authMiddleware, (req, res) => {
  const { clusterMore } = readSettings();
  const localPath = path.join(__dirname, 'morefunctions.json');
  const clusterPath = '/contract/contract_fs/seed/state/morefunctions.json';
  const selectedPath = clusterMore ? clusterPath : localPath;

  if (!fs.existsSync(selectedPath)) return res.json([]);
  const data = fs.readFileSync(selectedPath, 'utf8');
  res.json(JSON.parse(data));
});


app.post('/morefunctions/save', adminRateLimiter, authMiddleware, (req, res) => {
  const { cards } = req.body;
  if (!Array.isArray(cards)) return res.status(400).json({ error: 'Invalid format' });

  fs.writeFileSync(mfFile, JSON.stringify(cards, null, 2));
  res.json({ success: true });
});

app.get('/admin/folders', adminRateLimiter, authMiddleware, (req, res) => {
 // console.log('AUTH HEADER:', req.headers.authorization);
  const root = path.join(__dirname, 'public');

  function buildTree(dirPath) {
    const result = {};
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        result[item.name] = buildTree(path.join(dirPath, item.name));
      }
    }
    return result;
  }

  try {
    const tree = buildTree(root);
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read folders' });
  }
});

const NODELOG_PATHS = {
  stdout: '/home/everweb/webadmin.out.log',
  stderr: '/home/everweb/webadmin.err.log'
};

adminRouter.get('/nodestdout', adminRateLimiter, authMiddleware, (req, res) => {
  const file = NODELOG_PATHS.stdout;

  if (!fs.existsSync(file)) {
    return res.status(400).json({ error: 'File not found' });
  }

  try {
    const data = fs.readFileSync(file, 'utf8');
    res.set('Content-Type', 'text/plain');
res.send(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read stdout log' });
  }
});

adminRouter.get('/nodestderr', adminRateLimiter, authMiddleware, (req, res) => {
  const file = NODELOG_PATHS.stderr;

  if (!fs.existsSync(file)) {
    return res.status(400).json({ error: 'File not found' });
  }

  try {
    const data = fs.readFileSync(file, 'utf8');
    res.set('Content-Type', 'text/plain');
res.send(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read stderr log' });
  }
});



function loadHpKeypair(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw);

  if (!cfg.node?.public_key || !cfg.node?.private_key) {
    throw new Error('Missing public_key or private_key in hp.cfg');
  }

  return {
    publicKey: Buffer.from(cfg.node.public_key, 'hex'),
    privateKey: Buffer.from(cfg.node.private_key, 'hex')
  };
}

adminRouter.get('/my-vote', async (req, res) => {
  try {
    const raw = fs.readFileSync('/contract/cfg/hp.cfg', 'utf8');
    const cfg = JSON.parse(raw);
    const voterKey = cfg.node?.public_key;

    if (!voterKey) {
      return res.status(500).json({ error: 'Node public key not found in hp.cfg' });
    }

    const voteFilePath = '/contract/contract_fs/seed/state/votes.json';
    let votes = {};

    if (fs.existsSync(voteFilePath)) {
      votes = JSON.parse(fs.readFileSync(voteFilePath));
    }

    const activeVote = Object.entries(votes).find(
      ([version, entry]) =>
        entry.type === 'go-live' && entry.voters.includes(voterKey)
    );

    return res.json({ version: activeVote ? activeVote[0] : null });
  } catch (err) {
    console.error('[my-vote] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve vote' });
  }
});

adminRouter.get('/my-sidedish-vote', async (req, res) => {
  try {
    const raw = fs.readFileSync('/contract/cfg/hp.cfg', 'utf8');
    const cfg = JSON.parse(raw);
    const voterKey = cfg.node?.public_key;

    if (!voterKey) {
      return res.status(500).json({ error: 'Node public key not found in hp.cfg' });
    }

    // Read live version
    const liveFlagPath = '/contract/contract_fs/seed/state/.live_sidedish_version';
    let liveVersion = null;
    if (fs.existsSync(liveFlagPath)) {
      try {
        liveVersion = fs.readFileSync(liveFlagPath, 'utf8').trim();
      } catch (err) {
        console.warn('[my-sidedish-vote] Failed to read .live_sidedish_version:', err.message);
      }
    }

    // Read vote file
    const voteFilePath = '/contract/contract_fs/seed/state/sidedish_votes.json';
    let votes = {};
    if (fs.existsSync(voteFilePath)) {
      votes = JSON.parse(fs.readFileSync(voteFilePath));
    }

    let votedVersion = null;
    const transformed = {};

    for (const [version, data] of Object.entries(votes)) {
      const goLive = data.voters || [];
      const deleteVote = data.delete || [];

      if (goLive.includes(voterKey)) votedVersion = version;

      transformed[version] = {
        votes: goLive.length,
        votedByMe: goLive.includes(voterKey),
        deleteVotes: deleteVote.length,
        deleteVotedByMe: deleteVote.includes(voterKey)
      };
    }

    return res.json({
      sidedish: votedVersion,
      sidedishVotes: transformed,
      live: liveVersion || null
    });
  } catch (err) {
    console.error('[my-sidedish-vote] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve sidedish votes' });
  }
});


function writeHpCfgMultipleTimes(config, path, retries = 3, delay = 100) {
  for (let i = 0; i < retries; i++) {
    setTimeout(() => {
      fs.writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
      console.log(`[import-key] Write attempt ${i + 1} complete.`);
    }, i * delay);
  }
}
adminRouter.get('/read-sd-local', adminRateLimiter, authMiddleware, (req, res) => {
  const fullPath = path.join(__dirname, 'sidedish.js');

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'Local sidedish.js not found.' });
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    res.send({ content });
  } catch (err) {
    console.error('[read-sd-local] Error:', err.message);
    res.status(500).json({ error: 'Failed to read local sidedish.js.' });
  }
});

adminRouter.post('/save-sd-local', adminRateLimiter, authMiddleware, (req, res) => {
  const { content } = req.body;
  const fullPath = path.join(__dirname, 'sidedish.js');

  try {
    fs.writeFileSync(fullPath, content, 'utf8');
    res.send({ message: 'Local sidedish.js saved.' });
  } catch (err) {
    console.error('[save-sd-local] Error:', err.message);
    res.status(500).json({ error: 'Failed to save local sidedish.js.' });
  }
});

adminRouter.post('/fetch-sidedish', adminRateLimiter, authMiddleware, (req, res) => {
  const src = '/contract/contract_fs/seed/state/sidedish.js';
  const dest = '/home/everweb/sidedish.js';

  try {
    if (!fs.existsSync(src)) {
      return res.status(404).json({ error: 'sidedish.js not found in cluster.' });
    }

    fs.copyFileSync(src, dest);
    res.json({ message: 'sidedish.js copied from cluster to local seed path.' });
  } catch (err) {
    console.error('[fetch-sidedish] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch sidedish.js: ' + err.message });
  }
});

adminRouter.post('/promote-sidedish', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    if (!(await client.connect())) {
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    const payload = BSON.serialize({ type: 'sidedish-go-live', version });

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for output')), 10000);
      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      return res.status(500).json({ error: 'Contract rejected the input.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
    return res.json(response);
  } catch (err) {
    console.error('[promote-sidedish] failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/push-sidedish', adminRateLimiter, authMiddleware, async (req, res) => {
  const sidedishPath = path.join(__dirname, 'sidedish.js');

  if (!fs.existsSync(sidedishPath)) {
    return res.status(404).json({ error: 'Local sidedish.js not found.' });
  }

  const versionName = getUploadSuffix();
  const clusterDest = path.join(CLUSTER_ROOT, 'sidedish_versions', versionName);

  try {
    fs.mkdirSync(clusterDest, { recursive: true });
    fs.copyFileSync(sidedishPath, path.join(clusterDest, 'sidedish.js'));

    return res.json({ success: true, version: versionName, message: `Pushed to sidedish_versions/${versionName}/` });
  } catch (err) {
    console.error('[push-sidedish] Error:', err);
    return res.status(500).json({ error: 'Failed to push sidedish version: ' + err.message });
  }
});

adminRouter.post('/vote-delete-sd', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;
  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    if (!(await client.connect())) {
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    const payload = BSON.serialize({ type: 'sidedish-vote-delete', version });

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for output')), 10000);
      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      return res.status(500).json({ error: 'Contract rejected input.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
    return res.json(response);
  } catch (err) {
    console.error('[vote-delete-sd] failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/import-key', adminRateLimiter, authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) {
    return res.status(403).json({ error: 'Access denied. Admin only.' });
  }

  const { private_key, public_key } = req.body;

  if (!private_key || !public_key) {
    return res.status(400).json({ error: 'Missing key(s).' });
  }

  const hpConfigPath = '/contract/cfg/hp.cfg';

  try {
    if (!fs.existsSync(hpConfigPath)) {
      return res.status(500).json({ error: 'hp.cfg not found.' });
    }

    const raw = fs.readFileSync(hpConfigPath, 'utf8');
    const config = JSON.parse(raw);

    const oldPubKey = config.node.public_key;

    config.node.private_key = private_key;
    config.node.public_key = public_key;

    if (Array.isArray(config.contract.unl)) {
      const idx = config.contract.unl.findIndex(k => k === oldPubKey);
      if (idx !== -1) {
        config.contract.unl[idx] = public_key;
        console.log(`[import-key] Replaced old UNL key at index ${idx}`);
      } else {
        console.warn('[import-key] Old public key not found in UNL list — no changes made to UNL.');
      }
    }

    // Write multiple times with delay (for some reason it gets overwritten otherwise)
    writeHpCfgMultipleTimes(config, hpConfigPath, 5, 200);

    return res.json({ success: true });
  } catch (err) {
    console.error('[import-key] Failed to update hp.cfg:', err);
    return res.status(500).json({ error: 'Failed to update hp.cfg: ' + err.message });
  }
});

adminRouter.get('/show-keypair', adminRateLimiter, authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return res.status(403).json({ error: 'Access denied. Admin only.' });

  try {
    const cfgRaw = await fsp.readFile('/contract/cfg/hp.cfg', 'utf8');
    const cfg = JSON.parse(cfgRaw);

    const pub = cfg.node?.public_key;
    const priv = cfg.node?.private_key;

    if (!pub || !priv) {
      return res.status(500).json({ error: 'Keypair not found in config.' });
    }

    res.json({ publicKey: pub, privateKey: priv });
  } catch (err) {
    console.error('[show-keypair] Error:', err.message);
    res.status(500).json({ error: 'Failed to read keypair: ' + err.message });
  }
});

adminRouter.post('/sidedish-upload', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
    const uploadSuffix = getUploadSuffix();
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    const sidedishPath = path.join(__dirname, 'sidedish.js');
    if (!fs.existsSync(sidedishPath)) {
      return res.status(404).json({ error: 'sidedish.js not found on local system.' });
    }

    const fileBuffer = fs.readFileSync(sidedishPath);
    const chunkSize = 40 * 64 * 1024; // ~2.5MB
    const totalChunks = Math.ceil(fileBuffer.length / chunkSize);

    const connectOK = await client.connect();
    if (!connectOK) {
      return res.status(500).json({ error: 'Failed to connect to HotPocket cluster.' });
    }

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileBuffer.length);
      const chunk = fileBuffer.slice(start, end);

      const payload = {
        type: 'sidedish-upload',
        version: uploadSuffix,
        chunkNo: i + 1,
        totalChunks,
        chunk: chunk.toString('hex')
      };

      const submission = await client.submitContractInput(BSON.serialize(payload));
      const result = await submission.submissionStatus;

      if (result.status !== 'accepted') {
        client.close();
        return res.status(500).json({ error: `Chunk ${i + 1} rejected by contract.` });
      }
    }

    client.close();
    return res.json({ message: `sidedish.js uploaded as version '${uploadSuffix}'` });
  } catch (err) {
    console.error('[sidedish-upload] Error:', err);
    return res.status(500).json({ error: 'Failed to upload sidedish.js: ' + err.message });
  }
});

adminRouter.post('/promote-version', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg'); 

    const client = await HotPocket.createClient(
      [HOTPOCKET_WS_URL],
      keyPair,
      { protocol: HotPocket.protocols.bson }
    );

    const connected = await client.connect();
    if (!connected) {
      console.error('[error] Failed to connect to HotPocket cluster.');
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    console.log('[debug] Connected to HotPocket cluster');

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for contract output'));
      }, 10000);

      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const payload = BSON.serialize({ type: 'go-live', version });
    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      console.error('[error] Contract rejected input:', status);
      return res.status(500).json({ error: 'Contract rejected input.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
    if (response.type === 'success' || response.type === 'info') {
      console.log('[debug] Version promotion successful');
      return res.json({ message: response.message });
    } else {
      console.error('[error] Unexpected contract error:', response.error);
      return res.status(500).json({ error: response.message || 'Unexpected contract error' });
    }

  } catch (err) {
    console.error('[admin] promote-version failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

const hpConfigPath = '/contract/cfg/hp.cfg';
adminRouter.get('/hpinfo', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
    const data = await fsp.readFile(hpConfigPath, 'utf8');
    const config = JSON.parse(data);

    res.json({
      public_key: config.node.public_key,
      contract_id: config.contract.id,
      unl: config.contract.unl,
      known_peers: config.mesh.known_peers || [],
      user_port: config.user.port,
      mesh_port: config.mesh.port,
      roundtime: config.contract.consensus.roundtime,
      stage_slice: config.contract.consensus.stage_slice,
      threshold: config.contract.consensus.threshold,
    });
  } catch (error) {
    console.error('[hpinfo] ERROR reading hp.cfg:', error.message);
    res.status(500).json({ error: 'Failed to load hp config: ' + error.message });
  }  
});


adminRouter.post('/morefunctions-upload', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
    const version = getUploadSuffix(); // e.g. timestamp-based
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    const mfPath = path.join(__dirname, 'morefunctions.json');
    if (!fs.existsSync(mfPath)) {
      return res.status(404).json({ error: 'morefunctions.json not found on local system.' });
    }

    const fileBuffer = fs.readFileSync(mfPath);
    const chunkSize = 40 * 64 * 1024; // ~2.5MB
    const totalChunks = Math.ceil(fileBuffer.length / chunkSize);

    const connectOK = await client.connect();
    if (!connectOK) {
      return res.status(500).json({ error: 'Failed to connect to HotPocket cluster.' });
    }

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileBuffer.length);
      const chunk = fileBuffer.slice(start, end);

      const payload = {
        type: 'more-upload',
        version,
        chunkNo: i + 1,
        totalChunks,
        chunk: chunk.toString('hex')
      };

      const submission = await client.submitContractInput(BSON.serialize(payload));
      const result = await submission.submissionStatus;

      if (result.status !== 'accepted') {
        client.close();
        return res.status(500).json({ error: `Chunk ${i + 1} rejected by contract.` });
      }
    }

    client.close();
    return res.json({ message: `morefunctions.json uploaded as version '${version}'` });
  } catch (err) {
    console.error('[morefunctions-upload] Error:', err);
    return res.status(500).json({ error: 'Failed to upload morefunctions.json: ' + err.message });
  }
});


adminRouter.get('/list-morefunctions', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
  
    const raw = fs.readFileSync('/contract/cfg/hp.cfg', 'utf8');
    const cfg = JSON.parse(raw);
    const myPublicKey = cfg.node?.public_key;

    if (!myPublicKey) {
      return res.status(500).json({ error: 'Missing public key in hp.cfg' });
    }

    const liveFlagPath = '/contract/contract_fs/seed/state/.live_more_version';
    let liveVersion = null;
    if (fs.existsSync(liveFlagPath)) {
      try {
        const liveRaw = fs.readFileSync(liveFlagPath, 'utf8').trim();
        if (liveRaw.length > 0) {
          liveVersion = liveRaw;
        }
      } catch (err) {
        console.warn('[list-morefunctions] Failed to read .live_more_version:', err.message);
      }
    }

 
    const versionsRoot = '/contract/contract_fs/seed/state/more_versions';
    let versionNames = [];
    if (fs.existsSync(versionsRoot)) {
      const entries = fs.readdirSync(versionsRoot, { withFileTypes: true });
      versionNames = entries.filter(d => d.isDirectory()).map(d => d.name);
    }


    const votePath = '/contract/contract_fs/seed/state/more_votes.json';
    let votes = {};
    if (fs.existsSync(votePath)) {
      try {
        votes = JSON.parse(fs.readFileSync(votePath, 'utf8'));
      } catch (err) {
        console.warn('[list-morefunctions] Failed to parse more_votes.json:', err.message);
      }
    }

 
    const result = versionNames.map(name => {
      const voteEntry = votes[name] || {};
      const goLiveVoters = voteEntry.goLive || [];
      const deleteVoters = voteEntry.delete || [];

      return {
        name,
        votes: goLiveVoters.length,
        votedByMe: goLiveVoters.includes(myPublicKey),
        deleteVotes: deleteVoters.length,
        deleteVotedByMe: deleteVoters.includes(myPublicKey),
        isLive: name === liveVersion
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[list-morefunctions] Error:', err);
    res.status(500).json({ error: 'Failed to list morefunctions versions' });
  }
});

adminRouter.post('/morefunctions-fetch', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  try {
    const sourcePath = path.join(
      '/contract/contract_fs/seed/state/more_versions',
      version,
      'morefunctions.json'
    );

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: `Version '${version}' does not exist.` });
    }

    const content = fs.readFileSync(sourcePath, 'utf8');

    const destPath = path.join(__dirname, 'morefunctions.json');
    fs.writeFileSync(destPath, content);

    res.json({ message: `Version '${version}' saved to local morefunctions.json.` });
  } catch (err) {
    console.error('[morefunctions-fetch] Error:', err);
    res.status(500).json({ error: 'Failed to fetch version: ' + (err?.message || String(err)) });
  }
});


adminRouter.post('/morefunctions-promote', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version.' });
  }

  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    const connected = await client.connect();
    if (!connected) {
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for output')), 10000);
      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const payload = BSON.serialize({ type: 'more-go-live', version });
    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      return res.status(500).json({ error: 'Contract rejected input.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
    if (response.type === 'success' || response.type === 'info') {
      return res.json({ message: response.message });
    } else {
      return res.status(500).json({ error: response.error || 'Unexpected error' });
    }

  } catch (err) {
    console.error('[morefunctions-promote] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/morefunctions-deletevote', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version.' });
  }

  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    const connected = await client.connect();
    if (!connected) {
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for output')), 10000);
      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const payload = BSON.serialize({ type: 'more-vote-delete', version });
    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      return res.status(500).json({ error: 'Contract rejected input.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
    if (response.type === 'success' || response.type === 'info') {
      return res.json({ message: response.message });
    } else {
      return res.status(500).json({ error: response.error || 'Unexpected error' });
    }

  } catch (err) {
    console.error('[morefunctions-deletevote] Error:', err);
    res.status(500).json({ error: err.message });
  }
});






adminRouter.post('/generate-keypair', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
    const keypair = await HotPocket.generateKeys();

    const publicKeyHex = Buffer.from(keypair.publicKey).toString('hex');   // 64 hex chars
    const privateKeyHex = Buffer.from(keypair.privateKey).toString('hex'); // 128 hex chars

    res.json({
      success: true,
      publicKey: publicKeyHex,
      privateKey: privateKeyHex
    });
  } catch (err) {
    console.error('[generate-keypair] Failed:', err);
    res.status(500).json({ error: 'Failed to generate keypair.' });
  }
});

adminRouter.post('/add-user', adminRateLimiter, authMiddleware, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const hashFile = path.join(__dirname, 'password.hash');
  const users = loadUserCredentials();

  if (users[username]) {
    return res.status(400).json({ error: 'User already exists.' });
  }

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const entry = `${username}:${hash}\n`;
let current = '';
if (fs.existsSync(hashFile)) {
  current = fs.readFileSync(hashFile, 'utf-8');
  if (!current.endsWith('\n')) current += '\n';
}
fs.writeFileSync(hashFile, current + entry, 'utf-8');
  return res.json({ success: true, message: `User '${username}' added.` });
});

adminRouter.post('/remove-user', adminRateLimiter, authMiddleware, async (req, res) => {
  const { username } = req.body;

  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username is required.' });
  }

  if (username === 'admin') {
    return res.status(403).json({ error: 'Cannot remove protected user "admin".' });
  }

  const hashFile = path.join(__dirname, 'password.hash');
  if (!fs.existsSync(hashFile)) {
    return res.status(500).json({ error: 'Password file not found.' });
  }

  const users = loadUserCredentials();

  if (!users[username]) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const newLines = Object.entries(users)
    .filter(([user]) => user !== username)
    .map(([user, hash]) => `${user}:${hash}`)
    .join('\n') + '\n';

  fs.writeFileSync(hashFile, newLines, 'utf-8');
  return res.json({ success: true, message: `User '${username}' removed.` });
});

adminRouter.post('/change-password', adminRateLimiter, authMiddleware, async (req, res) => {
  const { username, oldPassword, newPassword, newPasswordConfirm } = req.body;

  if (!username || !oldPassword || !newPassword || !newPasswordConfirm) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  if (newPassword !== newPasswordConfirm) {
    return res.status(400).json({ error: 'New passwords do not match.' });
  }

  const users = loadUserCredentials();
  const storedHash = users[username];

  if (!storedHash) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const oldHash = crypto.createHash('sha256').update(oldPassword).digest('hex');
  if (oldHash !== storedHash) {
    return res.status(403).json({ error: 'Old password is incorrect.' });
  }

  const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
  users[username] = newHash;

  const newContent = Object.entries(users)
    .map(([user, hash]) => `${user}:${hash}`)
    .join('\n') + '\n';

  fs.writeFileSync(path.join(__dirname, 'password.hash'), newContent, 'utf-8');
  return res.json({ success: true, message: 'Password updated successfully.' });
});

adminRouter.post('/refresh-unl', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
    const keyPair = await HotPocket.generateKeys(null);
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    if (!(await client.connect())) {
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for contract output')), 10000);
      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const payload = BSON.serialize({ type: 'refresh-unl' });
    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      return res.status(500).json({ error: 'Contract rejected input.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
    if (response.type === 'success') {
      return res.json({ message: response.message });
    } else {
      return res.status(500).json({ error: response.error || 'Unexpected contract error' });
    }
  } catch (err) {
    console.error('[refresh-unl] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/hpinfo', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
    const data = await fsp.readFile(hpConfigPath, 'utf8');
    const config = JSON.parse(data);

    const updates = req.body;

    if (updates.public_key) config.node.public_key = updates.public_key;
    if (updates.contract_id) config.contract.id = updates.contract_id;
    if (updates.unl) config.contract.unl = updates.unl;
    if (updates.user_port) config.user.port = updates.user_port;
    if (updates.mesh_port) config.mesh.port = updates.mesh_port;
    if (updates.known_peers) config.mesh.known_peers = updates.known_peers;
    if (updates.roundtime) config.contract.consensus.roundtime = updates.roundtime;
    if (updates.stage_slice) config.contract.consensus.stage_slice = updates.stage_slice;
    if (updates.threshold) config.contract.consensus.threshold = updates.threshold;

    await fsp.writeFile(hpConfigPath, JSON.stringify(config, null, 4), 'utf8');

    res.json({ success: true });
  } catch (error) {
    console.error('[hpinfo POST] ERROR:', error.message);
    res.status(500).json({ error: 'Failed to update hp config: ' + error.message });
  }
});

const logMap = {
  hp: '/contract/log/hp.log',
  stdout: '/contract/log/contract/rw.stdout.log',
  stderr: '/contract/log/contract/rw.stderr.log'
};

adminRouter.post('/restart-hotpocket', adminRateLimiter, authMiddleware, async (req, res) => {
  const { exec } = require('child_process');

  exec('supervisorctl restart hotpocket', (error, stdout, stderr) => {
    if (error) {
      console.error('[restart-hotpocket] Exec error:', error);
      console.error('[restart-hotpocket] Stderr:', stderr);
      return res.status(500).json({ error: `Restart failed: ${stderr || error.message}` });
    }

    console.log('[restart-hotpocket] Stdout:', stdout);
    res.json({ message: 'HotPocket restarted.', output: stdout.trim() });
  });
});

adminRouter.post('/stop-hotpocket', adminRateLimiter, authMiddleware, async (req, res) => {
  const { exec } = require('child_process');

  exec('supervisorctl stop hotpocket', (error, stdout, stderr) => {
    if (error) {
      console.error('[stop-hotpocket] Exec error:', error);
      console.error('[stop-hotpocket] Stderr:', stderr);
      return res.status(500).json({ error: `Stop failed: ${stderr || error.message}` });
    }

    console.log('[stop-hotpocket] Stdout:', stdout);
    res.json({ message: 'HotPocket stopped.', output: stdout.trim() });
  });
});
adminRouter.get('/hotpocket-status', adminRateLimiter, authMiddleware, async (req, res) => {
  const { exec } = require('child_process');

  exec('supervisorctl status hotpocket', (error, stdout, stderr) => {
    if (error) {
      console.error('[hotpocket-status] Error:', error);
      return res.status(500).json({ error: 'Failed to check status.' });
    }

    const isRunning = stdout.includes('RUNNING');
    res.json({ running: isRunning, raw: stdout.trim() });
  });
});

adminRouter.get('/trace-log', adminRateLimiter, authMiddleware, (req, res) => {
  const fileKey = req.query.file;
  const logFile = logMap[fileKey];
  if (!logFile || !fs.existsSync(logFile)) {
    return res.status(400).json({ error: 'Invalid file' });
  }

  try {
    const data = fs.readFileSync(logFile, 'utf8');
    res.json({ log: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read log file' });
  }
});

adminRouter.get('/checksum', adminRateLimiter, authMiddleware, (req, res) => {
  const relPath = req.query.path;
  if (!relPath || relPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const fullPath = path.join(__dirname, 'public', relPath);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const fileBuffer = fs.readFileSync(fullPath);
  const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  res.json({ checksum });
});
adminRouter.get('/cluster-checksum', adminRateLimiter, authMiddleware, (req, res) => {
  const relPath = req.query.path;
  if (!relPath || relPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const fullPath = path.join(CLUSTER_ROOT, relPath);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const fileBuffer = fs.readFileSync(fullPath);
  const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  res.json({ checksum });
});
adminRouter.post('/cluster-checksums', adminRateLimiter, authMiddleware, (req, res) => {
  const files = req.body.files;
  if (!Array.isArray(files)) {
    return res.status(400).json({ error: 'Expected array of file paths' });
  }

  const checksums = {};
  for (const relPath of files) {
    if (relPath.includes('..')) continue;

    const fullPath = path.join(CLUSTER_ROOT, relPath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const buffer = fs.readFileSync(fullPath);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      checksums[relPath] = hash;
    } else {
      checksums[relPath] = null;
    }
  }

  res.json(checksums);
});

adminRouter.get('/file-info', adminRateLimiter, authMiddleware, (req, res) => {
  const relPath = req.query.path;
  if (!relPath || relPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const fullPath = path.join(__dirname, 'public', relPath);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
  const extension = path.extname(fullPath).toLowerCase();

  res.json({ mimeType, extension });
});

adminRouter.post('/fetch-sidedish', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  const clusterPath = path.join('/contract/contract_fs/seed/state/sidedish_versions', version, 'sidedish.js');
  const localPath = path.join(__dirname, 'public', 'sidedish.js');

  try {
    if (!fs.existsSync(clusterPath)) {
      return res.status(404).json({ error: `sidedish.js version '${version}' not found in cluster.` });
    }

    fs.copyFileSync(clusterPath, localPath);

    res.json({ message: `sidedish.js version '${version}' has been fetched and applied locally.` });
  } catch (err) {
    console.error('[fetch-sidedish] Error:', err);
    res.status(500).json({ error: 'Failed to fetch sidedish.js: ' + err.message });
  }
});

adminRouter.post('/fetch-version', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  const versionPath = path.join('/contract/contract_fs/seed/state/versions', version);
  const localRoot = path.join(__dirname, 'public');

  try {
    if (!fs.existsSync(versionPath)) {
      return res.status(404).json({ error: 'Version folder not found in cluster.' });
    }

    const copyRecursive = (srcDir, destDir) => {
      const entries = fs.readdirSync(srcDir, { withFileTypes: true });

      for (const entry of entries) {
        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
          copyRecursive(src, dest);
        } else if (entry.isFile()) {
          fs.copyFileSync(src, dest);
        }
      }
    };

    copyRecursive(versionPath, localRoot);

    res.json({ message: `Files from version '${version}' have been fetched and applied locally.` });
  } catch (err) {
    console.error('[fetch-version] Error:', err);
    res.status(500).json({ error: 'Failed to fetch files from version: ' + err.message });
  }
});

adminRouter.get('/list-versions', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
    const raw = fs.readFileSync('/contract/cfg/hp.cfg', 'utf8');
    const cfg = JSON.parse(raw);
    const myPublicKey = cfg.node?.public_key;

    if (!myPublicKey) {
      return res.status(500).json({ error: 'Missing public key in hp.cfg' });
    }

    const liveSymlink = '/contract/contract_fs/seed/state/public';
    let liveVersion = null;
    if (fs.existsSync(liveSymlink)) {
      const target = fs.readlinkSync(liveSymlink);
      liveVersion = path.basename(target);
    }

    const versionsRoot = '/contract/contract_fs/seed/state/versions';
    const entries = fs.readdirSync(versionsRoot, { withFileTypes: true });
    const versionNames = entries.filter(d => d.isDirectory()).map(d => d.name);

    const votePath = '/contract/contract_fs/seed/state/votes.json';
    let votes = {};
    if (fs.existsSync(votePath)) {
      votes = JSON.parse(fs.readFileSync(votePath, 'utf8'));
    }

    const result = versionNames.map(name => {
      const voteEntry = votes[name] || {};
const goLiveVoters = voteEntry.goLive || [];
const deleteVoters = voteEntry.delete || [];

      return {
        name,
        votes: goLiveVoters.length,
        votedByMe: goLiveVoters.includes(myPublicKey),
        deleteVotes: deleteVoters.length,
        deleteVotedByMe: deleteVoters.includes(myPublicKey),
        isLive: name === liveVersion
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[list-versions] Error:', err);
    res.status(500).json({ error: 'Failed to read version list' });
  }
});

adminRouter.post('/vote-delete', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');

    const client = await HotPocket.createClient(
      [HOTPOCKET_WS_URL],
      keyPair,
      { protocol: HotPocket.protocols.bson }
    );

    const connected = await client.connect();
    if (!connected) {
      return res.status(500).json({ error: 'Failed to connect to HotPocket cluster.' });
    }

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for contract output')), 10000);
      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const payload = BSON.serialize({ type: 'vote-delete', version });
    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      return res.status(500).json({ error: 'Contract rejected delete vote.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
    if (response.type === 'success' || response.type === 'info') {
      return res.json({ message: response.message });
    } else {
      return res.status(500).json({ error: response.error || 'Unexpected contract error' });
    }

  } catch (err) {
    console.error('[vote-delete] failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

const servePath = path.join(__dirname, 'public', 'live');
app.use(express.static(servePath));
adminRouter.get('/list-files', (req, res) => {
  const relPath = req.query.folder || '';
  const targetPath = path.join(__dirname, 'public', relPath);

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'Folder not found' });
  }

  const items = fs.readdirSync(targetPath, { withFileTypes: true });
  const result = items.map(item => ({
    name: item.name,
    type: item.isDirectory() ? 'folder' : 'file'
  }));

  res.json(result);
});

adminRouter.post('/delete-files', adminRateLimiter, authMiddleware, (req, res) => {
  const files = req.body.files || [];
  files.forEach(file => {
    const filePath = path.join(__dirname, 'public', file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });
  res.send({ message: 'Files deleted successfully' });
});

adminRouter.post('/create-folder', adminRateLimiter, authMiddleware, (req, res) => {
  let basePath = 'public';
  if (typeof req.body.base === 'string' && req.body.base.trim() !== '') {
    basePath = path.join('public', req.body.base);
  }
  const folderPath = path.join(__dirname, basePath, req.body.folder);
  fs.mkdirSync(folderPath, { recursive: true });
  res.send({ message: 'Folder created' });
});

adminRouter.post('/delete-folder', adminRateLimiter, authMiddleware, (req, res) => {
  if (!req.body.folder || req.body.folder.trim() === '') {
    return res.status(400).send({ error: 'Deleting the root public folder is not allowed' });
  }
  const folderPath = path.join(__dirname, 'public', req.body.folder);
  if (fs.existsSync(folderPath)) {
    fs.rmSync(folderPath, { recursive: true, force: true });
    res.send({ message: 'Folder deleted' });
  } else {
    res.status(404).send({ error: 'Folder not found' });
  }
});

adminRouter.get('/file', adminRateLimiter, authMiddleware, (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'Missing path' });

  const fullPath = path.join(__dirname, 'public', relPath);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });

  const content = fs.readFileSync(fullPath, 'utf-8');
  res.send({ content });
});

adminRouter.post('/file', adminRateLimiter, authMiddleware, (req, res) => {
  const { path: filePath, newPath, content = '' } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing file path' });

  const baseDir = path.join(__dirname, 'public');
  const oldFull = path.join(baseDir, filePath);
  const finalFull = newPath ? path.join(baseDir, newPath) : oldFull;

  if (newPath && newPath !== filePath) {
    if (fs.existsSync(oldFull)) {
      fs.renameSync(oldFull, finalFull);
    }
  }

  fs.writeFileSync(finalFull, content, 'utf-8');
  res.send({ message: 'File saved successfully' });
});

adminRouter.get('/settings', (req, res) => {
  if (!fs.existsSync(settingsPath)) {
    return res.json({ useCluster: false });
  }
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  res.json(settings);
});

adminRouter.post('/settings', adminRateLimiter, authMiddleware, (req, res) => {
  const { useCluster } = req.body;
  if (typeof useCluster !== 'boolean') {
    return res.status(400).json({ error: 'useCluster must be a boolean' });
  }
  fs.writeFileSync(settingsPath, JSON.stringify({ useCluster }, null, 2));
  res.json({ message: 'Settings updated' });
});

adminRouter.post('/sync-to-cluster', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
    await syncLocalFilesToCluster();
    res.json({ message: 'Sync completed successfully.' });
  } catch (err) {
    console.error('Sync failed:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

const clients = [];

app.get('/admin/sync-progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.push(res);

  req.on('close', () => {
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
  });
});

function broadcastProgress(message) {
  const data = `data: ${JSON.stringify({ message })}\n\n`;
  clients.forEach(res => res.write(data));
}

adminRouter.post('/go-live', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;
  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  try {
    const keyPair = await HotPocket.generateKeys(null);
    const client = await HotPocket.createClient(
      [HOTPOCKET_WS_URL],
      keyPair,
      { protocol: HotPocket.protocols.bson }
    );

    const connected = await client.connect();
    if (!connected) {
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for contract output'));
      }, 10000);

      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const payload = BSON.serialize({ type: 'go-live', version });
    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      return res.status(500).json({ error: 'Contract rejected input.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
if (response.type === 'success' || response.type === 'info') {
  return res.json({ message: response.message });
} else {
  return res.status(500).json({ error: response.error || 'Unexpected contract error' });
}

  } catch (err) {
    console.error('[go-live] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/admin', adminRateLimiter, adminRouter);

async function syncLocalFilesToCluster() {
  const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
  const uploadSuffix = getUploadSuffix();
  const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
    protocol: HotPocket.protocols.bson
  });

  function report(msg) {
    console.log(msg);
    broadcastProgress(msg);  
  }

  if (!(await client.connect())) {
    report("Failed to connect to HotPocket instance.");
    return;
  }

  report("Connected to HotPocket cluster.");

  const localDir = path.join(__dirname, 'public');

  function listAllFiles(dir, base = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let files = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(base, entry.name);

      if (entry.isDirectory()) {
        files = files.concat(listAllFiles(fullPath, relativePath));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }

    return files;
  }

  const files = listAllFiles(localDir);
  const chunkSize = 40 * 64 * 1024; // 2,4mb or so

  for (const relPath of files) {
    const fullPath = path.join(localDir, relPath);
    const fileBuffer = fs.readFileSync(fullPath);
    const totalChunks = Math.ceil(fileBuffer.length / chunkSize);
    const normalizedRelPath = relPath.replace(/\\/g, '/');

    report(`Uploading ${normalizedRelPath} (${fileBuffer.length} bytes, ${totalChunks} chunks)`);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileBuffer.length);
      const chunk = fileBuffer.slice(start, end);
      const chunkHex = chunk.toString('hex');

      const payload = {
        type: 'upload',
        filename: normalizedRelPath,
        chunkNo: i + 1,
        totalChunks,
        chunk: chunkHex,
        version: uploadSuffix
      };

      const contractInput = await client.submitContractInput(BSON.serialize(payload));
      const result = await contractInput.submissionStatus;

      if (result.status !== 'accepted') {
        report(`Chunk ${i + 1} of ${normalizedRelPath} was rejected.`);
        client.close();
        return;
      }

      report(`Chunk ${i + 1}/${totalChunks} sent for ${normalizedRelPath}`);
    }

    report(`Finished uploading ${normalizedRelPath}`);
  }

  client.close();
  report("Disconnected from HotPocket.");
}

const CLUSTER_ROOT = '/contract/contract_fs/seed/state';

adminRouter.get('/browse-cluster', adminRateLimiter, authMiddleware, (req, res) => {
  const result = {};

  function buildTree(dirPath) {
    const tree = {};
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        tree[item.name] = buildTree(fullPath);
      } else {
        tree[item.name] = null; // File = leaf
      }
    }
    return tree;
  }

  try {
    const tree = buildTree(CLUSTER_ROOT);
    res.json(tree);
  } catch (err) {
    console.error('Failed to browse cluster:', err);
    res.status(500).json({ error: 'Cluster browse failed' });
  }
});

adminRouter.get('/read-cluster', adminRateLimiter, authMiddleware, (req, res) => {
  const relPath = req.query.path;
  if (!relPath || relPath.includes('..')) {
    console.warn('Invalid path attempt:', relPath);
    return res.status(400).json({ error: 'Invalid path' });
  }

  const fullPath = path.join(CLUSTER_ROOT, relPath);
  console.log('Full path requested:', fullPath);

  if (!fs.existsSync(fullPath)) {
    console.warn('File does not exist:', fullPath);
    return res.status(404).json({ error: 'File not found' });
  }

  if (fs.statSync(fullPath).isDirectory()) {
    console.warn('Attempted to read directory:', fullPath);
    return res.status(400).json({ error: 'Path is a directory' });
  }

  const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
  const ext = path.extname(fullPath).toLowerCase();
  console.log(`MIME type: ${mimeType}, Extension: ${ext}`);

  const allowedMimeTypes = [
    'text/plain',
    'text/html',
    'text/css',
    'application/json',
    'application/javascript',
    'application/xml',
    'text/x-python',
    'text/x-c',
    'text/x-c++',
    'text/markdown',
    'text/x-sh',
    'application/x-httpd-php',
    'application/x-yaml',
    'application/x-sql',
  ];

  const allowedExtensions = [
    '.sh',
    '.cfg',
    '.override',
    '.conf',
    '.env',
    '.log',
    '.ini'
  ];

  if (!allowedMimeTypes.includes(mimeType) && !allowedExtensions.includes(ext)) {
    return res.status(415).json({ error: 'Unsupported Media Type for preview' });
  }

  res.setHeader('Content-Type', mimeType);
  res.sendFile(fullPath, err => {
    if (err) {
      console.error('Failed to send file:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});

adminRouter.get('/download-cluster', authMiddleware, (req, res) => {
  const relPath = req.query.path;
  if (!relPath || relPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const fullPath = path.join(CLUSTER_ROOT, relPath);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(fullPath, err => {
    if (err) {
      console.error('Failed to download file:', err);
      res.status(500).json({ error: 'Download error' });
    }
  });
});


















adminRouter.get('/my-api-vote', async (req, res) => {
  try {
    const raw = fs.readFileSync('/contract/cfg/hp.cfg', 'utf8');
    const cfg = JSON.parse(raw);
    const voterKey = cfg.node?.public_key;

    if (!voterKey) {
      return res.status(500).json({ error: 'Node public key not found in hp.cfg' });
    }

    const voteFilePath = '/contract/contract_fs/seed/state/api_votes.json';
    let votes = {};

    if (fs.existsSync(voteFilePath)) {
      votes = JSON.parse(fs.readFileSync(voteFilePath));
    }

    let votedVersion = null;
    const transformed = {};

    for (const [version, data] of Object.entries(votes)) {
      const goLive = data.voters || [];
      const deleteVote = data.delete || [];

      if (goLive.includes(voterKey)) votedVersion = version;

      transformed[version] = {
        votes: goLive.length,
        votedByMe: goLive.includes(voterKey),
        deleteVotes: deleteVote.length,
        deleteVotedByMe: deleteVote.includes(voterKey)
      };
    }

    return res.json({
      api: votedVersion,
      apiVotes: transformed
    });
  } catch (err) {
    console.error('[my-api-vote] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve api votes' });
  }
});

function writeHpCfgMultipleTimes(config, path, retries = 3, delay = 100) {
  for (let i = 0; i < retries; i++) {
    setTimeout(() => {
      fs.writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
      console.log(`[import-key] Write attempt ${i + 1} complete.`);
    }, i * delay);
  }
}

adminRouter.get('/list-api-versions', adminRateLimiter, authMiddleware, async (req, res) => {
  try {
    const raw = fs.readFileSync('/contract/cfg/hp.cfg', 'utf8');
    const cfg = JSON.parse(raw);
    const myPublicKey = cfg.node?.public_key;

    if (!myPublicKey) {
      return res.status(500).json({ error: 'Missing public key in hp.cfg' });
    }

    // Read live version flag from file
    const liveFlagPath = '/contract/contract_fs/seed/state/.live_api_version';
    let liveVersion = null;
    if (fs.existsSync(liveFlagPath)) {
      try {
        const liveRaw = fs.readFileSync(liveFlagPath, 'utf8').trim();
        if (liveRaw.length > 0) {
          liveVersion = liveRaw;
        }
      } catch (err) {
        console.warn('[list-api-versions] Failed to read .live_api_version:', err.message);
      }
    }

    // Read version folders
    const versionsRoot = '/contract/contract_fs/seed/state/api_versions';
    let versionNames = [];
    if (fs.existsSync(versionsRoot)) {
      const entries = fs.readdirSync(versionsRoot, { withFileTypes: true });
      versionNames = entries.filter(d => d.isDirectory()).map(d => d.name);
    }

    // Read votes
    const votePath = '/contract/contract_fs/seed/state/api_votes.json';
    let votes = {};
    if (fs.existsSync(votePath)) {
      try {
        votes = JSON.parse(fs.readFileSync(votePath, 'utf8'));
      } catch (err) {
        console.warn('[list-api-versions] Failed to parse api_votes.json:', err.message);
      }
    }

    // Assemble result
    const result = versionNames.map(name => {
      const voteEntry = votes[name] || {};
      const goLiveVoters = voteEntry.goLive || [];
      const deleteVoters = voteEntry.delete || [];

      return {
        name,
        votes: goLiveVoters.length,
        votedByMe: goLiveVoters.includes(myPublicKey),
        deleteVotes: deleteVoters.length,
        deleteVotedByMe: deleteVoters.includes(myPublicKey),
        isLive: name === liveVersion
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[list-api-versions] Error:', err);
    res.status(500).json({ error: 'Failed to list API versions' });
  }
});



adminRouter.get('/read-api-cluster', adminRateLimiter, authMiddleware, (req, res) => {
  const clusterPath = '/contract/contract_fs/seed/state/dynamic-endpoints-data.json';

  if (!fs.existsSync(clusterPath)) {
    return res.status(404).json({ error: 'Cluster dynamic-endpoints-data.json not found.' });
  }

  try {
    const content = fs.readFileSync(clusterPath, 'utf8');
    res.json({ content });
  } catch (err) {
    console.error('[read-api-cluster] Error:', err.message);
    res.status(500).json({ error: 'Failed to read cluster dynamic-endpoints-data.json.' });
  }
});


adminRouter.get('/read-api-local', adminRateLimiter, authMiddleware, (req, res) => {
  const fullPath = path.join(__dirname, 'dynamic-endpoints-data.json');

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'Local dynamic-endpoints-data.json not found.' });
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    res.send({ content });
  } catch (err) {
    console.error('[read-api-local] Error:', err.message);
    res.status(500).json({ error: 'Failed to read local dynamic-endpoints-data.json.' });
  }
});

adminRouter.post('/save-api-local', adminRateLimiter, authMiddleware, (req, res) => {
  const { content } = req.body;
  const fullPath = path.join(__dirname, 'dynamic-endpoints-data.json');

  try {
    fs.writeFileSync(fullPath, content, 'utf8');
    res.send({ message: 'Local dynamic-endpoints-data.json saved.' });
  } catch (err) {
    console.error('[save-api-local] Error:', err.message);
    res.status(500).json({ error: 'Failed to save local dynamic-endpoints-data.json.' });
  }
});

adminRouter.post('/fetch-api', adminRateLimiter, authMiddleware, (req, res) => {
  const src = '/contract/contract_fs/seed/state/dynamic-endpoints-data.json';
  const dest = '/home/everweb/dynamic-endpoints-data.json';

  try {
    if (!fs.existsSync(src)) {
      return res.status(404).json({ error: 'dynamic-endpoints-data.json not found in cluster.' });
    }

    fs.copyFileSync(src, dest);
    res.json({ message: 'dynamic-endpoints-data.json copied from cluster to local seed path.' });
  } catch (err) {
    console.error('[fetch-api] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dynamic-endpoints-data.json: ' + err.message });
  }
});

adminRouter.post('/promote-api', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    if (!(await client.connect())) {
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    const payload = BSON.serialize({ type: 'api-go-live', version });

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for output')), 10000);
      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      return res.status(500).json({ error: 'Contract rejected the input.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
    return res.json(response);
  } catch (err) {
    console.error('[promote-api] failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/push-api', adminRateLimiter, authMiddleware, async (req, res) => {
  const filePath = path.join(__dirname, 'dynamic-endpoints-data.json');

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Local dynamic-endpoints-data.json not found.' });
  }

  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    if (!(await client.connect())) {
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    const fileBuffer = fs.readFileSync(filePath);
    const chunkSize = 1024 * 1024; // 1MB
    const totalChunks = Math.ceil(fileBuffer.length / chunkSize);
    const version = getUploadSuffix();

    for (let i = 0; i < totalChunks; i++) {
      const chunk = fileBuffer.slice(i * chunkSize, (i + 1) * chunkSize);
      const payload = BSON.serialize({
        type: 'api-upload',
        version,
        chunkNo: i + 1,
        totalChunks,
        chunk: chunk.toString('hex')
      });

      const submission = await client.submitContractInput(payload);
      const status = await submission.submissionStatus;

      if (status.status !== 'accepted') {
        client.close();
        return res.status(500).json({ error: `Contract rejected chunk ${i + 1}` });
      }

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for contract response')), 10000);
        client.on(HotPocket.events.contractOutput, output => {
          clearTimeout(timeout);
          resolve(output);
        });
      });

      const decoded = BSON.deserialize(result.outputs[0]);
      if (decoded.type === 'error') {
        client.close();
        return res.status(500).json({ error: decoded.error });
      }
    }

    client.close();
    return res.json({
      success: true,
      version,
      message: `Uploaded dynamic-endpoints-data.json to api_versions/${version}/`
    });

  } catch (err) {
    console.error('[push-api] Upload failed:', err);
    return res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});


adminRouter.post('/vote-delete-api', adminRateLimiter, authMiddleware, async (req, res) => {
  const { version } = req.body;
  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid version name.' });
  }

  try {
    const keyPair = loadHpKeypair('/contract/cfg/hp.cfg');
    const client = await HotPocket.createClient([HOTPOCKET_WS_URL], keyPair, {
      protocol: HotPocket.protocols.bson
    });

    if (!(await client.connect())) {
      return res.status(500).json({ error: 'Failed to connect to cluster.' });
    }

    const payload = BSON.serialize({ type: 'api-vote-delete', version });

    const waitForOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for output')), 10000);
      client.on(HotPocket.events.contractOutput, result => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    const submission = await client.submitContractInput(payload);
    const status = await submission.submissionStatus;

    if (status.status !== 'accepted') {
      client.close();
      return res.status(500).json({ error: 'Contract rejected input.' });
    }

    const result = await waitForOutput;
    client.close();

    const response = BSON.deserialize(result.outputs[0]);
    return res.json(response);
  } catch (err) {
    console.error('[vote-delete-api] failed:', err);
    return res.status(500).json({ error: err.message });
  }
});










const PORTS = [36525, 36527, 36529];

// Optionally read EXTERNAL_GPTCP1_PORT from env.vars
const envFile = '/contract/env.vars';
if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    const lines = content.split('\n');

    lines.forEach(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('EXTERNAL_GPTCP1_PORT=')) {
            const [, value] = trimmed.split('=');
            const externalPort = parseInt(value, 10);
            if (!isNaN(externalPort) && !PORTS.includes(externalPort)) {
                PORTS.push(externalPort);
                console.log(`Added external port from env.vars: ${externalPort}`);
            }
        }
    });
}


PORTS.forEach(port => {
    const server = https.createServer(sslOptions, app);
    server.listen(port, () => {
        console.log(`HTTPS Server running at https://localhost:${port}`);
    });
    server.on('error', (err) => {
        console.error(`Failed to start server on port ${port}:`, err.message);
    });
});
