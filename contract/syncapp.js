const fs = require('fs');
const path = require('path');

const stateRoot = 'public'; 

export class syncapp {
  sendOutput;
  sendRawOutput;
  
   clearSidedishVotes(voter, entry) {
  if (entry.voters?.includes(voter)) {
    entry.voters = entry.voters.filter(k => k !== voter);
  }
  if (entry.delete?.includes(voter)) {
    entry.delete = entry.delete.filter(k => k !== voter);
  }
}

async init(ctx) {
    this.contractCtx = ctx;
    const configRaw = await fs.promises.readFile('/contract/cfg/hp.cfg', 'utf8');
    const hpconfig = JSON.parse(configRaw);
    this.unl = new Set(hpconfig.contract?.unl || []);
    const threshold = hpconfig.contract?.consensus?.threshold || 100; 
    this.quorumThreshold = threshold / 100; 
  }

  async handleRequest(user, message, isReadOnly) {
    console.log(`[syncapp] Received message type: ${message.type}`);
console.log(`[syncapp] User index:`, user.userId || user.index || user);
console.log(`[syncapp] About to send output to user:`, user);
    if (isReadOnly) {
      await this.sendOutput(user, {
        type: 'error',
        error: 'Read-only mode is not supported for syncing.'
      });
      return;
    }

else if (message.type === 'go-live') {
  const versionName = message.version;
  const voter = user.publicKey;

  if (!this.unl.has(voter)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized voter. Must be in UNL.'
    });
    return;
  }

  const voteFilePath = path.join('votes.json');
  let votes = fs.existsSync(voteFilePath) ? JSON.parse(fs.readFileSync(voteFilePath)) : {};

  if (!votes[versionName]) {
    votes[versionName] = { goLive: [], delete: [] };
  }


  for (const [ver, entry] of Object.entries(votes)) {
    if (ver !== versionName && entry.goLive?.includes(voter)) {
      entry.goLive = entry.goLive.filter(pk => pk !== voter);
      console.log(`[syncapp] ${voter} removed go-live vote from '${ver}'`);
    }
  }


  votes[versionName].delete = votes[versionName].delete.filter(pk => pk !== voter);


  if (!votes[versionName].goLive.includes(voter)) {
    votes[versionName].goLive.push(voter);
    console.log(`[syncapp] ${voter} voted to go-live '${versionName}'`);
  }


  for (const entry of Object.values(votes)) {
    entry.goLive = entry.goLive.filter(pk => this.unl.has(pk));
    entry.delete = entry.delete.filter(pk => this.unl.has(pk));
  }

  fs.writeFileSync(voteFilePath, JSON.stringify(votes));


  const totalVotes = votes[versionName].goLive.length;
  const quorum = Math.ceil(this.unl.size * this.quorumThreshold);

  if (totalVotes >= quorum) {
    const livePath = '/contract/contract_fs/seed/state/public';
    const versionsPath = `/contract/contract_fs/seed/state/versions/${versionName}`;

    if (!fs.existsSync(versionsPath)) {
      await this.sendOutput(user, {
        type: 'error',
        error: `Version '${versionName}' does not exist.`
      });
      return;
    }

    if (fs.existsSync(livePath)) {
      fs.rmSync(livePath, { recursive: true, force: true });
    }

    fs.symlinkSync(versionsPath, livePath, 'dir');


    for (const entry of Object.values(votes)) {
      entry.goLive = [];
    }

    fs.writeFileSync(voteFilePath, JSON.stringify(votes));

    await this.sendOutput(user, {
      type: 'success',
      message: `Version '${versionName}' is now live by consensus.`
    });
    return;
  }

  await this.sendOutput(user, {
    type: 'info',
    message: `Vote recorded for '${versionName}'. Waiting for quorum (${totalVotes}/${quorum}).`
  });
  return;
}


else if (message.type === 'api-go-live') {
  const versionName = message.version;
  const voter = user.publicKey;

  if (!this.unl.has(voter)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized voter. Must be in UNL.'
    });
    return;
  }

  const voteFilePath = 'api_votes.json';
  let votes = fs.existsSync(voteFilePath) ? JSON.parse(fs.readFileSync(voteFilePath)) : {};

  if (!votes[versionName]) {
    votes[versionName] = { goLive: [], delete: [] };
  }


  for (const [ver, entry] of Object.entries(votes)) {
    if (ver !== versionName && entry.goLive?.includes(voter)) {
      entry.goLive = entry.goLive.filter(pk => pk !== voter);
    }
  }


  votes[versionName].delete = votes[versionName].delete.filter(pk => pk !== voter);


  if (!votes[versionName].goLive.includes(voter)) {
    votes[versionName].goLive.push(voter);
  }


  for (const entry of Object.values(votes)) {
    entry.goLive = entry.goLive.filter(pk => this.unl.has(pk));
    entry.delete = entry.delete.filter(pk => this.unl.has(pk));
  }

  fs.writeFileSync(voteFilePath, JSON.stringify(votes));


  const totalVotes = votes[versionName].goLive.length;
  const quorum = Math.ceil(this.unl.size * this.quorumThreshold);

  if (totalVotes >= quorum) {
    const livePath = 'dynamic-endpoints-data.json';
    const versionsPath = `api_versions/${versionName}/dynamic-endpoints-data.json`;

    if (!fs.existsSync(versionsPath)) {
      await this.sendOutput(user, {
        type: 'error',
        error: `Version '${versionName}' does not exist.`
      });
      return;
    }

    try {
      fs.copyFileSync(versionsPath, livePath);

      const liveDir = path.dirname(livePath);
      const liveFlagPath = path.join(liveDir, '.live_api_version');
      fs.writeFileSync(liveFlagPath, versionName);
    } catch (err) {
      await this.sendOutput(user, {
        type: 'error',
        error: `Failed to promote dynamic-endpoints-data.json: ${err.message}`
      });
      return;
    }


    for (const entry of Object.values(votes)) {
      entry.goLive = [];
    }

    fs.writeFileSync(voteFilePath, JSON.stringify(votes));

    await this.sendOutput(user, {
      type: 'success',
      message: `dynamic-endpoints-data.json version '${versionName}' is now live.`
    });
  } else {
    await this.sendOutput(user, {
      type: 'info',
      message: `Vote recorded for API '${versionName}' (${totalVotes}/${quorum})`
    });
  }

  return;
}


else if (message.type === 'api-vote-delete') {
  const versionName = message.version;
  const voter = user.publicKey;

  if (!this.unl.has(voter)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized voter. Must be in UNL.'
    });
    return;
  }

  const voteFilePath = 'api_votes.json';
  let votes = fs.existsSync(voteFilePath) ? JSON.parse(fs.readFileSync(voteFilePath)) : {};

  const livePath = 'dynamic-endpoints-data.json';
  const currentLive = fs.existsSync(livePath)
    ? fs.readFileSync(livePath, 'utf8')
    : null;

  const versionPath = path.join('api_versions', versionName, 'dynamic-endpoints-data.json');

  if (!fs.existsSync(versionPath)) {
    await this.sendOutput(user, {
      type: 'error',
      error: `Version '${versionName}' does not exist. Cannot vote to delete.`
    });
    return;
  }

  if (!votes[versionName]) {
    votes[versionName] = { goLive: [], delete: [] };
  }

  const entry = votes[versionName];


  entry.goLive = entry.goLive.filter(pk => pk !== voter);


  if (!entry.delete.includes(voter)) {
    entry.delete.push(voter);
    console.log(`[api-vote-delete] ${voter} voted to delete '${versionName}'`);
  } else {
    console.log(`[api-vote-delete] ${voter} already voted to delete '${versionName}'`);
  }


  for (const e of Object.values(votes)) {
    e.goLive = e.goLive.filter(pk => this.unl.has(pk));
    e.delete = e.delete.filter(pk => this.unl.has(pk));
  }

  const totalVotes = votes[versionName].delete.length;
  const quorum = Math.ceil(this.unl.size * this.quorumThreshold);

  console.log(`[api-vote-delete] Delete votes for '${versionName}':`, votes[versionName].delete);
  console.log(`[api-vote-delete] Total votes: ${totalVotes}, Quorum required: ${quorum}`);

  const liveVersion = fs.existsSync(livePath) && fs.existsSync(versionPath)
    ? fs.readFileSync(versionPath, 'utf8') === currentLive
    : false;

  if (liveVersion) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Cannot delete the live API version.'
    });
    return;
  }

  if (totalVotes >= quorum) {
    const folderPath = path.dirname(versionPath);
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      delete votes[versionName];
      fs.writeFileSync(voteFilePath, JSON.stringify(votes));
      console.log(`[api-vote-delete] API version '${versionName}' deleted by quorum.`);
      await this.sendOutput(user, {
        type: 'success',
        message: `API version '${versionName}' has been deleted.`
      });
    } else {
      await this.sendOutput(user, {
        type: 'error',
        error: `Version '${versionName}' does not exist.`
      });
    }
  } else {
    fs.writeFileSync(voteFilePath, JSON.stringify(votes));
    await this.sendOutput(user, {
      type: 'info',
      message: `Voted to delete API version '${versionName}' (${totalVotes}/${quorum})`
    });
  }

  return;
}

else if (message.type === 'vote-delete') {
  const versionName = message.version;
  const voter = user.publicKey;

  if (!this.unl.has(voter)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized voter. Must be in UNL.'
    });
    return;
  }

  const voteFilePath = path.join('votes.json');
  let votes = fs.existsSync(voteFilePath) ? JSON.parse(fs.readFileSync(voteFilePath)) : {};

  const liveSymlink = '/contract/contract_fs/seed/state/public';
  const liveVersion = fs.existsSync(liveSymlink)
    ? path.basename(fs.readlinkSync(liveSymlink))
    : null;

  if (versionName === liveVersion) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Cannot vote to delete the live version.'
    });
    return;
  }

  if (!votes[versionName]) {
    votes[versionName] = { goLive: [], delete: [] };
  }

  votes[versionName].goLive = votes[versionName].goLive.filter(pk => pk !== voter);

  const entry = votes[versionName];
  const alreadyVoted = entry.delete.includes(voter);

  if (alreadyVoted) {
    entry.delete = entry.delete.filter(pk => pk !== voter);
    console.log(`[syncapp] ${voter} unvoted to delete '${versionName}'`);
  } else {
    entry.delete.push(voter);
    console.log(`[syncapp] ${voter} voted to delete '${versionName}'`);
  }

  for (const e of Object.values(votes)) {
    e.goLive = e.goLive.filter(pk => this.unl.has(pk));
    e.delete = e.delete.filter(pk => this.unl.has(pk));
  }

  const totalVotes = votes[versionName].delete.length;
  const quorum = Math.ceil(this.unl.size * this.quorumThreshold);

  if (totalVotes >= quorum) {
    const versionPath = path.join('versions', versionName);
    if (fs.existsSync(versionPath)) {
      fs.rmSync(versionPath, { recursive: true, force: true });
      delete votes[versionName];
      fs.writeFileSync(voteFilePath, JSON.stringify(votes));
      console.log(`[syncapp] Version '${versionName}' deleted by consensus.`);
      await this.sendOutput(user, {
        type: 'success',
        message: `Version '${versionName}' has been deleted by consensus.`
      });
    } else {
      await this.sendOutput(user, {
        type: 'error',
        error: `Version '${versionName}' does not exist.`
      });
    }
  } else {
    fs.writeFileSync(voteFilePath, JSON.stringify(votes));
    await this.sendOutput(user, {
      type: 'info',
      message: `${alreadyVoted ? 'Unvoted' : 'Voted'} to delete '${versionName}'. (${totalVotes}/${quorum})`
    });
  }

  return;
}


else if (message.type === 'list-versions') {
      const versionsPath = path.join('versions');
      console.log(`[syncapp] list-versions triggered`);
      console.log(`[syncapp] Looking in: ${versionsPath}`);
     
      try {
        if (!fs.existsSync(versionsPath)) {
          console.warn(`[syncapp] No versions directory found.`);
          await this.sendOutput(user, { type: 'versions', data: [] });
          return;
        }
    
        const entries = fs.readdirSync(versionsPath);
        console.log(`[syncapp] Entries in versions/:`, entries);
    
        const versions = entries.filter(entry => {
          const full = path.join(versionsPath, entry);
          const isDir = fs.statSync(full).isDirectory();
      
          return isDir;
        });
    
        console.log(`[syncapp] Found version folders:`, versions);
    
        await this.sendOutput(user, {
          type: 'versions',
          data: versions
        });
    
      } catch (err) {
        console.error(`[syncapp] Error reading versions: ${err.message}`);
        await this.sendOutput(user, {
          type: 'error',
          error: `Failed to read versions: ${err.message}`
        });
      }
    
      return;
    }

else if (message.type === 'api-upload') {
  const { version, chunkNo, totalChunks, chunk } = message;
  console.log(`[api-upload] Upload received from ${user.publicKey}`);

  if (!this.unl.has(user.publicKey)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized API uploader. Must be in UNL.'
    });
    return;
  }

  if (!version || !chunkNo || !totalChunks || !chunk) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Missing fields in API upload.'
    });
    return;
  }

  try {
    const versionedPath = path.join('api_versions', version, 'dynamic-endpoints-data.json');
    const versionDir = path.dirname(versionedPath);
    if (!fs.existsSync(versionDir)) {
      fs.mkdirSync(versionDir, { recursive: true });
      console.log(`[api-upload] Created folder: ${versionDir}`);
    }

    const chunkData = Buffer.from(chunk, 'hex');
    fs.appendFileSync(versionedPath, chunkData);
    console.log(`[api-upload] Wrote chunk ${chunkNo}/${totalChunks} â†’ ${versionedPath}`);

    if (parseInt(chunkNo) === parseInt(totalChunks)) {
      console.log(`[api-upload] Upload complete.`);
      await this.sendOutput(user, {
        type: 'success',
        message: `API uploaded as version '${version}'`
      });
    } else {
      await this.sendOutput(user, {
        type: 'ack',
        chunkNo
      });
    }

  } catch (err) {
    console.error(`[api-upload] Upload error: ${err.message}`);
    await this.sendOutput(user, {
      type: 'error',
      error: `Failed to store chunk ${chunkNo}: ${err.message}`
    });
  }
}


else if (message.type === 'more-upload') {
  const { version, chunkNo, totalChunks, chunk } = message;
  console.log(`[more-upload] Upload received from ${user.publicKey}`);

  if (!this.unl.has(user.publicKey)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized more uploader. Must be in UNL.'
    });
    return;
  }

  if (!version || !chunkNo || !totalChunks || !chunk) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Missing fields in more upload.'
    });
    return;
  }

  try {
    const versionedPath = path.join('more_versions', version, 'morefunctions.json');
    const versionDir = path.dirname(versionedPath);
    if (!fs.existsSync(versionDir)) {
      fs.mkdirSync(versionDir, { recursive: true });
      console.log(`[more-upload] Created folder: ${versionDir}`);
    }

    const chunkData = Buffer.from(chunk, 'hex');
    fs.appendFileSync(versionedPath, chunkData);
    console.log(`[more-upload] Wrote chunk ${chunkNo}/${totalChunks} â†’ ${versionedPath}`);

    if (parseInt(chunkNo) === parseInt(totalChunks)) {
      console.log(`[more-upload] Upload complete.`);
      await this.sendOutput(user, {
        type: 'success',
        message: `more uploaded as version '${version}'`
      });
    } else {
      await this.sendOutput(user, {
        type: 'ack',
        chunkNo
      });
    }

  } catch (err) {
    console.error(`[more-upload] Upload error: ${err.message}`);
    await this.sendOutput(user, {
      type: 'error',
      error: `Failed to store chunk ${chunkNo}: ${err.message}`
    });
  }
}
else if (message.type === 'more-go-live') {
  const versionName = message.version;
  const voter = user.publicKey;

  if (!this.unl.has(voter)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized voter. Must be in UNL.'
    });
    return;
  }

  const voteFilePath = 'more_votes.json';
  let votes = fs.existsSync(voteFilePath) ? JSON.parse(fs.readFileSync(voteFilePath)) : {};

  if (!votes[versionName]) {
    votes[versionName] = { goLive: [], delete: [] };
  }

  for (const [ver, entry] of Object.entries(votes)) {
    if (ver !== versionName && entry.goLive?.includes(voter)) {
      entry.goLive = entry.goLive.filter(pk => pk !== voter);
    }
  }

  votes[versionName].delete = votes[versionName].delete.filter(pk => pk !== voter);

  if (!votes[versionName].goLive.includes(voter)) {
    votes[versionName].goLive.push(voter);
  }

  for (const entry of Object.values(votes)) {
    entry.goLive = entry.goLive.filter(pk => this.unl.has(pk));
    entry.delete = entry.delete.filter(pk => this.unl.has(pk));
  }

  fs.writeFileSync(voteFilePath, JSON.stringify(votes));

  const totalVotes = votes[versionName].goLive.length;
  const quorum = Math.ceil(this.unl.size * this.quorumThreshold);

  if (totalVotes >= quorum) {
    const livePath = 'morefunctions.json';
    const versionsPath = path.join('more_versions', versionName, 'morefunctions.json');

    if (!fs.existsSync(versionsPath)) {
      await this.sendOutput(user, {
        type: 'error',
        error: `Version '${versionName}' does not exist.`
      });
      return;
    }

    try {
      fs.copyFileSync(versionsPath, livePath);
      fs.writeFileSync('.live_more_version', versionName);
    } catch (err) {
      await this.sendOutput(user, {
        type: 'error',
        error: `Failed to promote morefunctions.json: ${err.message}`
      });
      return;
    }

    for (const entry of Object.values(votes)) {
      entry.goLive = [];
    }

    fs.writeFileSync(voteFilePath, JSON.stringify(votes));

    await this.sendOutput(user, {
      type: 'success',
      message: `morefunctions.json version '${versionName}' is now live.`
    });
  } else {
    await this.sendOutput(user, {
      type: 'info',
      message: `Vote recorded for more '${versionName}' (${totalVotes}/${quorum})`
    });
  }

  return;
}


else if (message.type === 'more-vote-delete') {
  const versionName = message.version;
  const voter = user.publicKey;

  if (!this.unl.has(voter)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized voter. Must be in UNL.'
    });
    return;
  }

  const voteFilePath = 'more_votes.json';
  let votes = fs.existsSync(voteFilePath)
    ? JSON.parse(fs.readFileSync(voteFilePath, 'utf8'))
    : {};

  const liveFlagPath = '.live_more_version';
  const liveVersion = fs.existsSync(liveFlagPath)
    ? fs.readFileSync(liveFlagPath, 'utf8').trim()
    : null;

  if (liveVersion === versionName) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Cannot delete the live more version.'
    });
    return;
  }

  if (!votes[versionName]) {
    votes[versionName] = { goLive: [], delete: [] };
  }

  const entry = votes[versionName];

  entry.goLive = entry.goLive.filter(pk => pk !== voter);

  const alreadyVoted = entry.delete.includes(voter);
  if (alreadyVoted) {
    entry.delete = entry.delete.filter(pk => pk !== voter);
  } else {
    entry.delete.push(voter);
  }

  for (const e of Object.values(votes)) {
    e.goLive = e.goLive.filter(pk => this.unl.has(pk));
    e.delete = e.delete.filter(pk => this.unl.has(pk));
  }

  const totalVotes = votes[versionName].delete.length;
  const quorum = Math.ceil(this.unl.size * this.quorumThreshold);

  const versionFolder = path.join('more_versions', versionName);

  if (totalVotes >= quorum) {
    if (fs.existsSync(versionFolder)) {
      fs.rmSync(versionFolder, { recursive: true, force: true });
      delete votes[versionName];
      fs.writeFileSync(voteFilePath, JSON.stringify(votes));
      await this.sendOutput(user, {
        type: 'success',
        message: `more version '${versionName}' has been deleted.`
      });
    } else {
      await this.sendOutput(user, {
        type: 'error',
        error: `Version '${versionName}' does not exist.`
      });
    }
  } else {
    fs.writeFileSync(voteFilePath, JSON.stringify(votes));
    await this.sendOutput(user, {
      type: 'info',
      message: `${alreadyVoted ? 'Unvoted' : 'Voted'} to delete more version '${versionName}' (${totalVotes}/${quorum})`
    });
  }

  return;
}

else if (message.type === 'sidedish-upload') {
  const { version, chunkNo, totalChunks, chunk } = message;
  console.log(`[sidedish] Upload received from ${user.publicKey}`);

  if (!this.unl.has(user.publicKey)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized sidedish uploader. Must be in UNL.'
    });
    return;
  }

  if (!version || !chunkNo || !totalChunks || !chunk) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Missing fields in sidedish upload.'
    });
    return;
  }

  try {
    const versionedPath = path.join('sidedish_versions', version, 'sidedish.js');
    const versionDir = path.dirname(versionedPath);
    if (!fs.existsSync(versionDir)) {
      fs.mkdirSync(versionDir, { recursive: true });
      console.log(`[sidedish] Created folder: ${versionDir}`);
    }

    const chunkData = Buffer.from(chunk, 'hex');
    fs.appendFileSync(versionedPath, chunkData);
    console.log(`[sidedish] Wrote chunk ${chunkNo}/${totalChunks} â†’ ${versionedPath}`);

    if (parseInt(chunkNo) === parseInt(totalChunks)) {
      console.log(`[sidedish] Upload complete.`);
      await this.sendOutput(user, {
        type: 'success',
        message: `sidedish.js uploaded as version '${version}'`
      });
    } else {
      await this.sendOutput(user, {
        type: 'ack',
        chunkNo
      });
    }

  } catch (err) {
    console.error(`[sidedish] Upload error: ${err.message}`);
    await this.sendOutput(user, {
      type: 'error',
      error: `Failed to store chunk ${chunkNo}: ${err.message}`
    });
  }
}

else if (message.type === 'sidedish-go-live') {
  const versionName = message.version;
  const voter = user.publicKey;

  const votePath = 'sidedish_votes.json';
  let votes = fs.existsSync(votePath) ? JSON.parse(fs.readFileSync(votePath)) : {};

  const versionPath = path.join('sidedish_versions', versionName, 'sidedish.js');
  if (!fs.existsSync(versionPath)) {
    await this.sendOutput(user, { type: 'error', error: `Version '${versionName}' does not exist.` });
    return true;
  }

  if (!this.unl.has(voter)) {
    await this.sendOutput(user, { type: 'error', error: 'Unauthorized voter.' });
    return true;
  }

  for (const entry of Object.values(votes)) {
    if (entry.voters?.includes(voter)) {
      entry.voters = entry.voters.filter(pk => pk !== voter);
    }
  }

  if (!votes[versionName]) votes[versionName] = {};
  if (!votes[versionName].voters) votes[versionName].voters = [];
  if (!votes[versionName].delete) votes[versionName].delete = [];

  votes[versionName].voters.push(voter);

  for (const entry of Object.values(votes)) {
    entry.voters = entry.voters.filter(pk => this.unl.has(pk));
    entry.delete = entry.delete.filter(pk => this.unl.has(pk));
  }

  fs.writeFileSync(votePath, JSON.stringify(votes));

  const quorum = Math.ceil(this.unl.size * this.quorumThreshold);
  const totalVotes = votes[versionName].voters.length;

  if (totalVotes >= quorum) {
    const livePath = 'sidedish.js';
    const sourcePath = path.join('sidedish_versions', versionName, 'sidedish.js');

    try {
      fs.copyFileSync(sourcePath, livePath);
      fs.writeFileSync('.live_sidedish_version', versionName);
      console.log(`[sidedish] Activated version '${versionName}'`);
    } catch (err) {
      console.error(`[sidedish] Activation error: ${err.message}`);
      await this.sendOutput(user, { type: 'error', error: `Activation failed: ${err.message}` });
      return true;
    }

    votes[versionName].voters = [];
    fs.writeFileSync(votePath, JSON.stringify(votes));

    await this.sendOutput(user, {
      type: 'success',
      message: `sidedish.js version '${versionName}' is now live.`
    });
  } else {
    await this.sendOutput(user, {
      type: 'info',
      message: `Vote recorded for '${versionName}' (${totalVotes}/${quorum})`
    });
  }

  return true;
}


else if (message.type === 'sidedish-vote-delete') {
  const versionName = message.version;
  const voter = user.publicKey;

  const votePath = 'sidedish_votes.json';
  let votes = fs.existsSync(votePath) ? JSON.parse(fs.readFileSync(votePath)) : {};

  if (!this.unl.has(voter)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized voter.'
    });
    return true;
  }

  if (!votes[versionName]) votes[versionName] = { voters: [], delete: [] };
  const entry = votes[versionName];

  entry.voters = entry.voters.filter(pk => pk !== voter);

  const alreadyVoted = entry.delete.includes(voter);
  if (alreadyVoted) {
    entry.delete = entry.delete.filter(pk => pk !== voter);
  } else {
    entry.delete.push(voter);
  }

  for (const e of Object.values(votes)) {
    e.voters = e.voters.filter(pk => this.unl.has(pk));
    e.delete = e.delete.filter(pk => this.unl.has(pk));
  }

  const totalVotes = votes[versionName].delete.length;
  const quorum = Math.ceil(this.unl.size * this.quorumThreshold);

  if (totalVotes >= quorum) {
    const versionPath = path.join('sidedish_versions', versionName);
    if (fs.existsSync(versionPath)) {
      fs.rmSync(versionPath, { recursive: true, force: true });
      delete votes[versionName];
      fs.writeFileSync(votePath, JSON.stringify(votes));
      await this.sendOutput(user, {
        type: 'success',
        message: `Deleted sidedish version '${versionName}'`
      });
    } else {
      await this.sendOutput(user, {
        type: 'error',
        error: `Version '${versionName}' not found.`
      });
    }
  } else {
    fs.writeFileSync(votePath, JSON.stringify(votes));
    await this.sendOutput(user, {
      type: 'info',
      message: `${alreadyVoted ? 'Unvoted' : 'Voted'} to delete '${versionName}'. (${totalVotes}/${quorum})`
    });
  }

  return true;
}

else if (message.type === 'upload') {
      const { filename, chunkNo, totalChunks, chunk, version } = message;
  console.log(`[syncapp] Received upload message from ${user.publicKey}`);
  if (!this.unl.has(user.publicKey)) {
    await this.sendOutput(user, {
      type: 'error',
      error: 'Unauthorized uploader. Must be in UNL.'
    });
    return;
  }

      if (!filename || !chunkNo || !totalChunks || !chunk || !version) {
        console.log(`[syncapp] Missing upload fields.`);
        await this.sendOutput(user, {
          type: 'error',
          error: 'Missing required fields: filename, chunkNo, totalChunks, chunk, version'
        });
        return;
      }

      try {
        const normalizedFilename = filename.replace(/\\/g, '/');
        const versionedPath = path.join('versions', version, normalizedFilename);

        const versionDir = path.dirname(versionedPath);
        if (!fs.existsSync(versionDir)) {
          fs.mkdirSync(versionDir, { recursive: true });
          console.log(`[syncapp] Created version folder: ${versionDir}`);
        }

        const chunkData = Buffer.from(chunk, 'hex');
        fs.appendFileSync(versionedPath, chunkData);
        console.log(`[syncapp] Chunk ${chunkNo}/${totalChunks} written â†’ ${versionedPath}`);

        if (parseInt(chunkNo) === parseInt(totalChunks)) {
          console.log(`[syncapp] File complete: ${versionedPath}`);
          await this.sendOutput(user, {
            type: 'success',
            message: `File '${normalizedFilename}' stored in version '${version}'.`
          });
        } else {
          await this.sendOutput(user, {
            type: 'ack',
            chunkNo
          });
        }

      } catch (err) {
        console.error(`[syncapp] Chunk ${chunkNo} error: ${err.message}`);
        await this.sendOutput(user, {
          type: 'error',
          error: `Failed to store chunk ${chunkNo}: ${err.message}`
        });
      }

    } else {
      await this.sendOutput(user, {
        type: 'error',
        error: 'Unknown message type.'
      });
    }
  }
}