<p align="center">
  <img src="icon.svg" width="88" height="88" alt="UK TV icon: a television with an antenna">
</p>

<h1 align="center">Hert's UK TV</h1>

<p align="center">UK-made shows streaming right now on BBC iPlayer, ITVX, Channel 4 and Dave / UKTV, for Stremio. Sorted by genre, updated every week.</p>

<p align="center">
  <a href="https://web.stremio.com/#/addons?addon=https%3A%2F%2Fhertn.github.io%2Fuk-tv-list%2Fmanifest.json"><img src="https://img.shields.io/badge/install-in%20Stremio-7b5cf0?style=flat&amp;labelColor=15181e" alt="Install in Stremio"></a>
  <a href="https://ko-fi.com/hertn"><img src="https://img.shields.io/badge/support-%E2%9D%A4%20Ko--fi-ff5e5b?style=flat&amp;labelColor=15181e&amp;logo=kofi&amp;logoColor=white" alt="Support on Ko-fi"></a>
</p>

## Install

Press **Install in Stremio** above, or open **Addons** in Stremio and paste this link into the search bar:

```
https://hertn.github.io/uk-tv-list/manifest.json
```

## Use

Open **Discover**, choose **Series**, then pick a catalog from the dropdown: **BBC iPlayer**, **ITVX**, **Channel 4** or **Dave / UKTV**. Each one has a genre filter (Crime & Mystery, Drama, Comedy, Soaps, Sci-Fi & Fantasy, Documentary, Reality & Lifestyle, Talk & Panel, Kids & Animation, Action & Adventure, War & History).

Posters, descriptions and episodes come from Stremio's built-in Cinemeta and your own stream addons. This addon only lists the shows.

## How it stays up to date

A GitHub Action runs every Monday. It asks [TMDB](https://www.themoviedb.org) which UK-made shows are available on each service in the UK, looks up their IMDb ids, and rewrites the catalog files. Stremio picks up the changes on its own.

Availability data comes from TMDB (powered by JustWatch) and can lag behind the services or occasionally be wrong. This product uses the TMDB API but is not endorsed or certified by TMDB.

## Support

Hert's UK TV is free, with no ads and no tracking. If you like it, you can buy me a coffee on [Ko-fi](https://ko-fi.com/hertn).
