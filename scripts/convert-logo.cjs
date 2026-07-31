const sharp = require('sharp');
sharp('images/logo.svg').png().resize(512, 512).toFile('images/icon.png')
  .then(() => console.log('icon generated'))
  .catch((error) => { console.error(error); process.exit(1); });
