// The newest DictateAI release on GitHub and its Mac disk image. Files
// starting with _ aren't routes on Vercel; download.js and latest.js share it.
const REPO = 'ali050786/dictateai';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

async function latestDmg() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dictateai-site',
      // Optional: without it GitHub allows 60 lookups an hour, plenty with
      // the CDN caching each answer for 10 minutes.
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = await res.json();
  const dmg = (release.assets || []).find((asset) => asset.name.endsWith('.dmg'));
  if (!dmg) throw new Error(`Release ${release.tag_name} has no .dmg`);
  return {
    version: release.tag_name.replace(/^v/, ''),
    name: dmg.name,
    size: dmg.size,
    url: dmg.browser_download_url,
    published: release.published_at,
  };
}

// Answers are cached at the edge for 10 minutes, and served stale for a day
// if GitHub is slow, so a new release shows up within minutes.
const CACHE = 's-maxage=600, stale-while-revalidate=86400';

module.exports = { latestDmg, RELEASES_PAGE, CACHE };
