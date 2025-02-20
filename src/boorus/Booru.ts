/**
 * @packageDocumentation
 * @module Boorus
 */

import { fetch } from 'undici'
import { BooruError, defaultOptions, searchURI } from '../Constants'
import { jsonfy, resolveSite, shuffle, tryParseJSON } from '../Utils'

import InternalSearchParameters from '../structures/InternalSearchParameters'
import Post from '../structures/Post'
import SearchParameters from '../structures/SearchParameters'
import SearchResults from '../structures/SearchResults'
import Site from '../structures/Site'

// Shut up the compiler
// This attempts to find and use the native browser fetch, if possible
// Fixes https://github.com/AtoraSuunva/booru/issues/51
declare const window: any
const resolvedFetch: typeof fetch =
  typeof window !== 'undefined' ? window.fetch.bind(window) : fetch

export type BooruCredentials = Record<string, string>

interface SearchUrlParams {
  tags: string[]
  limit: number
  page: number
}

/*
 - new Booru
 => Constructor, params {name, {nsfw, {search, postView, ...}, random}, {apiTokens...}}
 => .search([tags...], {limit, random})
 => .postView(id)
 => .site
 */

/**
 * A basic, JSON booru
 * @example
 * ```
 * const Booru = require('booru')
 * // Aliases are supported
 * const e9 = Booru('e9')
 *
 * // You can then search the site
 * const imgs = await e9.search(['cat', 'cute'], {limit: 3})
 *
 * // And use the images
 * imgs.forEach(i => console.log(i.fileUrl))
 *
 * // Or access other methods on the Booru
 * e9.postView(imgs[0].id)
 * ```
 */
export class Booru {
  /** The domain of the booru */
  public domain: string
  /** The site object representing this booru */
  public site: Site
  /** The credentials to use for this booru */
  public credentials?: BooruCredentials

  /**
   * Create a new booru from a site
   *
   * @private
   * @param site The site to use
   * @param credentials Credentials for the API (Currently not used)
   */
  constructor(site: Site, credentials?: BooruCredentials) {
    const domain = resolveSite(site.domain)

    if (domain === null) {
      throw new Error(`Invalid site passed: ${site}`)
    }

    this.domain = domain
    this.site = site
    this.credentials = credentials
  }

  /**
   * Search for images on this booru
   * @param {String|String[]} tags The tag(s) to search for
   * @param {SearchParameters} searchArgs The arguments for the search
   * @return {Promise<SearchResults>} The results as an array of Posts
   */
  public async search(
    tags: string | string[],
    {
      limit = 1,
      random = false,
      page = 0,
      showUnavailable = false,
    }: SearchParameters = {},
  ): Promise<SearchResults> {
    const fakeLimit: number = random && !this.site.random ? 100 : 0

    try {
      const searchResult = await this.doSearchRequest(tags, {
        limit,
        random,
        page,
        showUnavailable,
      })
      return this.parseSearchResult(searchResult, {
        fakeLimit,
        tags,
        limit,
        random,
        page,
        showUnavailable,
      })
    } catch (err) {
      if (err instanceof Error) {
        throw new BooruError(err)
      } else {
        throw err
      }
    }
  }

  /**
   * Gets the url you'd see in your browser from a post id for this booru
   *
   * @param {String} id The id to get the postView for
   * @return {String} The url to the post
   */
  public postView(id: string | number): string {
    if (typeof id === 'string' && Number.isNaN(parseInt(id, 10))) {
      throw new BooruError(`Not a valid id for postView: ${id}`)
    }

    return `http${this.site.insecure ? '' : 's'}://${this.domain}${
      this.site.api.postView
    }${id}`
  }

  /**
   * The internal & common searching logic, pls dont use this use .search instead
   *
   * @protected
   * @param {String[]|String} tags The tags to search with
   * @param {InternalSearchParameters} searchArgs The arguments for the search
   * @return {Promise<Object>}
   */
  protected async doSearchRequest(
    tags: string[] | string,
    {
      uri = null,
      limit = 1,
      random = false,
      page = 0,
    }: InternalSearchParameters = {},
  ): Promise<any> {
    if (!Array.isArray(tags)) tags = [tags]

    // Used for random on sites without order:random
    let fakeLimit: number | undefined

    if (random) {
      if (this.site.random) {
        tags.push('order:random')
      } else {
        fakeLimit = 100
      }
    }

    if (this.site.defaultTags) {
      tags = tags.concat(this.site.defaultTags.filter((v) => !tags.includes(v)))
    }

    const fetchuri =
      uri || this.getSearchUrl({ tags, limit: fakeLimit || limit, page })
    const options = defaultOptions
    const xml = this.site.type === 'xml'

    try {
      const response = await resolvedFetch(fetchuri, options)

      // Check for CloudFlare ratelimiting
      if (response.status === 503) {
        const body = await response.clone().text()
        if (body.includes('cf-browser-verification')) {
          throw new BooruError(
            "Received a CloudFlare browser verification request. Can't proceed.",
          )
        }
      }

      const data = await response.text()
      const posts = xml ? jsonfy(data) : tryParseJSON(data)

      if (!response.ok) {
        throw new BooruError(
          `Received HTTP ${response.status} ` +
            `from booru: '${
              (posts as any).error ||
              (posts as any).message ||
              JSON.stringify(posts)
            }'`,
        )
      } else {
        return posts
      }
    } catch (err) {
      if ((err as any).type === 'invalid-json') return ''
      throw err
    }
  }

  /**
   * Generates a URL to search the booru with, mostly for debugging purposes
   * @param opt
   * @param {string[]} [opt.tags] The tags to search for
   * @param {number} [opt.limit] The limit of results to return
   * @param {number} [opt.page] The page of results to return
   * @returns A URL to search the booru
   */
  getSearchUrl({
    tags = [],
    limit = 100,
    page = 1,
  }: Partial<SearchUrlParams> = {}): string {
    return searchURI(this.site, tags, limit, page, this.credentials)
  }

  /**
   * Parse the response from the booru
   *
   * @protected
   * @param {Object} result The response of the booru
   * @param {InternalSearchParameters} searchArgs The arguments used for the search
   * @return {SearchResults} The results of this search
   */
  protected parseSearchResult(
    result: any,
    {
      fakeLimit,
      tags,
      limit,
      random,
      page,
      showUnavailable,
    }: InternalSearchParameters,
  ): SearchResults {
    if (result.success === false) {
      throw new BooruError(result.message || result.reason)
    }

    // Gelbooru
    if (result['@attributes']) {
      const attributes = result['@attributes']

      if (attributes.count === '0' || !result.post) {
        result = []
      } else if (Array.isArray(result.post)) {
        result = result.post
      } else {
        result = [result.post]
      }
    }

    if (result.posts) {
      result = result.posts
    }

    if (result.images) {
      result = result.images
    }

    let r: string[] | undefined
    // If gelbooru/other booru decides to return *nothing* instead of an empty array
    if (result === '') {
      r = []
    } else if (fakeLimit) {
      r = shuffle(result)
    } else if (result.constructor === Object) {
      // For XML based sites
      r = [result]
    }

    const results = r || result
    let posts: Post[] = results
      .slice(0, limit)
      .map((v: any) => new Post(v, this))
    const options = { limit, random, page, showUnavailable }

    if (tags === undefined) {
      tags = []
    }

    if (!Array.isArray(tags)) {
      tags = [tags]
    }

    if (!showUnavailable) {
      posts = posts.filter((p) => p.available)
    }

    return new SearchResults(posts, tags, options, this)
  }
}

export default Booru
