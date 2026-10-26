const { latestDmg, CACHE } = require('./_release');

// /api/latest: the newest version, its disk image and size, for the
// download buttons on the page.
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const dmg = await latestDmg();
    res.setHeader('Cache-Control', CACHE);
    res.statusCode = 200;
    res.end(JSON.stringify(dmg));
  } catch (err) {
    console.error(`[latest] ${err.message}`);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'Could not reach GitHub' }));
  }
};
