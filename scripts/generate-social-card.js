'use strict';

const fs=require('fs');
const path=require('path');
const sharp=require('sharp');

const ROOT=path.join(__dirname,'..');
const DIST_ASSETS=path.join(ROOT,'dist','assets');
const SOCIAL_SOURCE=path.join(ROOT,'assets','vla-social-card.svg');
const ICON_SOURCE=path.join(ROOT,'assets','vla-icon.svg');

async function render(){
  fs.mkdirSync(DIST_ASSETS,{recursive:true});
  await sharp(SOCIAL_SOURCE)
    .resize(1200,630,{fit:'fill'})
    .png({compressionLevel:9,quality:100})
    .toFile(path.join(DIST_ASSETS,'vla-social-card.png'));
  for(const size of [32,180,512]){
    await sharp(ICON_SOURCE)
      .resize(size,size,{fit:'contain',background:{r:255,g:250,b:240,alpha:1}})
      .png({compressionLevel:9,quality:100})
      .toFile(path.join(DIST_ASSETS,`vla-icon-${size}.png`));
  }
  const social=await sharp(path.join(DIST_ASSETS,'vla-social-card.png')).metadata();
  if(social.width!==1200||social.height!==630||social.format!=='png')throw new Error('SOCIAL_CARD_INVALID');
  const touch=await sharp(path.join(DIST_ASSETS,'vla-icon-180.png')).metadata();
  if(touch.width!==180||touch.height!==180||touch.format!=='png')throw new Error('TOUCH_ICON_INVALID');
  console.log('VLA_SOCIAL_ASSETS_OK 1200x630 + icons 32/180/512');
}

render().catch(error=>{console.error(error.stack||error);process.exit(1)});
