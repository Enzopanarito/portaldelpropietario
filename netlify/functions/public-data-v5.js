'use strict';

const snapshotLayer=require('./public-data-v3');
const guardedAccounting=require('./public-data-v4');

const handler=snapshotLayer.createHandler({previousHandler:guardedAccounting.handler});
exports.handler=handler;
module.exports={handler};
