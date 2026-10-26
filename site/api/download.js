const { latestDmg, RELEASES_PAGE, CACHE } = require('./_release');

// /download (see vercel.json): sends the browser to the newest disk image,
// so links to it never point at an old version. If GitHub can't be reached,
// to the release page instead.
module.exports = async (req, res) => {
  try {
    const dmg = await latestDmg();
    res.setHeader('Cache-Control', CACHE);
    res.writeHead(302, { Location: dmg.url });
  } catch (err) {
    console.error(`[download] ${err.message}`);
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: RELEASES_PAGE });
  }
  res.end();
};
