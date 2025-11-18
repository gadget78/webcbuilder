const HotPocket = require('hotpocket-nodejs-contract');
const bson = require('bson');
const { syncapp } = require('./syncapp');

let SideDish;
try {
  SideDish = require('./sidedish');
} catch (err) {
  console.warn('[contract] No active sidedish.js found, using fallback.');
  SideDish = require('./sidedish_fallback');
}

async function contract(ctx) {
  const isReadOnly = ctx.readonly;
  const app = new syncapp();

  let sidedish;

  try {
    sidedish = new SideDish();
    await sidedish.init(ctx, bson);
  } catch (err) {
    console.warn('[sidedish] init() failed, falling back:', err);
    const Fallback = require('./sidedish_fallback');
    sidedish = new Fallback();
    await sidedish.init(ctx, bson);
  }


  const sendOutput = async (user, output) => user.send(bson.serialize(output));
  const sendRawOutput = async (user, output) => user.send(output);
  const sendSideOutput = async (user, output) => user.send(bson.serialize(output));
  const sendSideRawOutput = async (user, output) => user.send(output);

  await app.init(ctx);
  app.sendOutput = sendOutput;
  app.sendRawOutput = sendRawOutput;
  sidedish.sideOutput = sendSideOutput;
  sidedish.sideRawOutput = sendSideRawOutput;

  for (const user of ctx.users.list()) {
    for (const input of user.inputs) {
      const buf = await ctx.users.read(input);
      const message = bson.deserialize(buf);

      let handled = false;

      try {
        handled = await sidedish.handleRequest(user, message, isReadOnly);
      } catch (err) {
        console.warn('[sidedish] handleRequest() failed, falling back:', err);
        const Fallback = require('./sidedish_fallback');
        sidedish = new Fallback();
        await sidedish.init(ctx, bson);
        handled = await sidedish.handleRequest(user, message, isReadOnly);
      }

      if (!handled) {
        await app.handleRequest(user, message, isReadOnly);
      }
    }
  }

  if (!isReadOnly && app.tempFilesWritten?.size > 0 && app.cleanupTempFiles) {
    await app.cleanupTempFiles();
  }
}

const hpc = new HotPocket.Contract();
hpc.init(contract);