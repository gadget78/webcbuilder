class SideDish {
    async init(ctx, bson) {
      this.ctx = ctx;
      this.bson = bson;
  
      const configRaw = await require('fs').promises.readFile('/contract/cfg/hp.cfg', 'utf8');
      const hpconfig = JSON.parse(configRaw);
  
      // Normalize UNL keys as lowercase hex strings
      this.unl = new Set((hpconfig.contract?.unl || []).map(k => k.toLowerCase()));
  
      console.log('[sidedish] Hotpocket is the lunch, but what is the sidedish?');
    }
  
    async handleRequest(user, message, isReadOnly) {
      console.log('[sidedish] Received message:', message);
  
      if (message.type === 'echo') {
        const reply = {
          type: 'echo-reply',
          message: `Echo from sidedish: ${message.payload}`,
        };
        console.log('[sidedish] Sending reply:', reply);
        await user.send(this.bson.serialize(reply));
        return true;
      }
  
      if (message.type === 'check-unl') {
        const userHexKey = user.publicKey.toString('hex').toLowerCase();
        const isInUNL = this.unl.has(userHexKey);
        const reply = {
          type: 'check-unl-reply',
          inUnl: isInUNL,
          publicKey: userHexKey,
        };
        console.log('[sidedish] UNL check result:', reply);
        await user.send(this.bson.serialize(reply));
        return true;
      }
  
      if (message.type === 'send-keys') {
        const reply = {
          type: 'send-keys-reply',
          receivedPublicKey: message.publicKey || null,
          receivedPrivateKey: message.privateKey || null,
        };
  
        if (!message.publicKey || !message.privateKey) {
          reply.error = 'Missing public or private key in request';
        }
  
        console.log('[sidedish] Sending key echo reply:', reply);
        await user.send(this.bson.serialize(reply));
        return true;
      }
  
      // Fallback for unknown message types
      const errorReply = {
        type: 'error',
        message: `Unknown message type: ${message.type || 'undefined'}`,
      };
      console.warn('[sidedish] Message not for me, sending it to the next in line.', message);
      
      return false;
    }
  }
  
  module.exports = SideDish;