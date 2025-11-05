import { BSON } from 'bson';

import { brotliDecompressSync } from 'zlib';

import { version as appVersion } from './package.json';

import type {
  tokenBody,
  resoniteInventoryRecord,
  oxibooruFunctionTypes,
  uploadPostResponse,
  validatePostResponse,
  safetyLevels,
  getTagCategoriesResponse,
  getTagResponse,
  userId,
  getTagSearchResponse,
  getPostSearchResponse,
} from './types';

import { HTTPMethodOxibooru } from './types';

import config from './config.json';
import { version } from 'os';

// #region get userToken
async function authenticateWithResonite(
  totpCode?: string
): Promise<{ tokenBody: tokenBody; Authorization: string; requiresTOTP: boolean }> {
  const authHeaders: Record<string, string> = {
    UID: process.env.resoniteMachineId as string,
    'Content-Type': 'application/json',
  };

  if (totpCode && totpCode.trim() !== '') {
    authHeaders.TOTP = totpCode;
  }

  const tokenResp = await fetch('https://api.resonite.com/userSessions', {
    method: HTTPMethodOxibooru.post,
    body: JSON.stringify({
      username: process.env.resoniteUsername as string,
      authentication: {
        $type: 'password',
        password: process.env.resonitePassword as string,
      },
      secretMachineId: `${crypto.randomUUID()}`,
      rememberMe: false,
    }),
    headers: authHeaders,
  });

  if (!tokenResp.ok) {
    const errorText = await tokenResp.text();

    if (errorText === 'TOTP') {
      return { tokenBody: null as any, Authorization: '', requiresTOTP: true };
    }

    throw new Error(
      `Authentication failed: ${tokenResp.status} ${tokenResp.statusText} - ${errorText}`
    );
  }

  const tokenBody = (await tokenResp.json()) as tokenBody;
  const Authorization = `res ${tokenBody.entity.userId}:${tokenBody.entity.token}`;

  return { tokenBody, Authorization, requiresTOTP: false };
}

let tokenBody: tokenBody;
let Authorization: string;

const authResult = await authenticateWithResonite();

if (authResult.requiresTOTP) {
  console.log('2FA is required for this account.');
  console.log('Please enter your 6-digit TOTP code:');

  const totpCode = await new Promise<string>((resolve) => {
    process.stdin.once('data', (data: Buffer) => {
      resolve(data.toString().trim());
    });
  });

  process.stdin.destroy();

  const retryResult = await authenticateWithResonite(totpCode);
  tokenBody = retryResult.tokenBody;
  Authorization = retryResult.Authorization;
} else {
  tokenBody = authResult.tokenBody;
  Authorization = authResult.Authorization;
}
// #endregion

// #region get scr records
const recordsRaw = await fetch(
  `https://api.resonite.com/users/${tokenBody.entity.userId}/records?path=${config.resonite.photoLocation}`,
  { headers: { Authorization } }
);
const baseRecords = (await recordsRaw.json()) as resoniteInventoryRecord[];

// convert resDB int record url
const downloadRecords = baseRecords
  .filter((record) => record.assetUri)
  .filter((record) => record.assetUri!.includes('.brson'))
  .filter((record) => record.recordType === 'object')
  .filter((record) => record.name.startsWith('Photo in '))
  .map((record) => {
    const outRecord = record;
    outRecord.assetURL = record
      .assetUri!.replace('resdb:///', 'https://assets.resonite.com/')
      .replace(/\.brson$/, '');
    return outRecord;
  });
// #endregion

// #region prepare asset
// upcycle data and cleanup broken pictures.
const assetRecords = await Promise.all(
  downloadRecords.map(async (record) => {
    // get resonite asset, that holds the component layout and image data
    const rewFileOut = await fetch(record.assetURL);
    const downloadedFile = await rewFileOut.bytes();
    // brotli only uses buffers and remove a file prefix that causes issues on decompression: https://git.unix.dog/yosh/misc-scripts/src/commit/960d187fe42afb4ea2761c54e0e33ddfc54da2ab/resonite-photoexif#L108
    const buffer = Buffer.from(downloadedFile).subarray(9);
    const decompressedFile = await brotliDecompressSync(buffer);
    if (decompressedFile.length === 0) {
      throw new Error(`Unable to decompress Resonite asset: ${record.assetURL}`);
    }
    const doc = await BSON.deserialize(decompressedFile);
    const outRecord = record;

    let components = null;
    if (doc.Object.Children.length !== 0) components = doc.Object.Children[0].Components.Data;
    else if (doc.Object.Components.Data.length !== 0) components = doc.Object.Components.Data;
    if (!components) return null;

    let staticTexture2D: any = null;
    let photoMetadata: any = null;
    // determine if screenshot is legacy or not
    if (doc.Types) {
      staticTexture2D = components.find(
        (comp: any) => comp.Type === doc.Types.indexOf('[FrooxEngine]FrooxEngine.StaticTexture2D')
      );
      photoMetadata = components.find(
        (comp: any) => comp.Type === doc.Types.indexOf('[FrooxEngine]FrooxEngine.PhotoMetadata')
      );
    } else {
      // legacy screenshots lack the Types definition. This is a hack to find the components with the correct data.
      config.resonite.photoSystemsLegacy.forEach((photoSystem) => {
        if (record.tags.includes(photoSystem.triggerTag)) {
          staticTexture2D = components.find((comp: any) =>
            photoSystem.staticTexture2D.includes(comp.Type)
          );
          photoMetadata = components.find((comp: any) =>
            photoSystem.photoMetadata.includes(comp.Type)
          );
        }
      });
    }

    if (!photoMetadata || !staticTexture2D) {
      throw new Error(`Not a known image system or not a screenshot. ${outRecord}`);
    }
    outRecord.assetURL = staticTexture2D.Data.URL.Data.replace(/\.[^.]+$/, '').replace(
      '@resdb:///',
      'https://assets.resonite.com/'
    );

    // cleanup dataset
    outRecord.photoMetadata = {
      location: {
        name: photoMetadata.Data.LocationName.Data.replace(/<[^>]+>/g, ''),
        host: photoMetadata.Data.LocationHost._userId.Data,
        accessLevel: photoMetadata.Data.LocationAccessLevel.Data,
        hiddenFromListing: photoMetadata.Data.LocationHiddenFromListing.Data,
      },
      timeTaken: photoMetadata.Data.TimeTaken.Data,
      takenBy: photoMetadata.Data.TakenBy._userId.Data,
      appVersion: photoMetadata.Data.AppVersion.Data,
      userIds: photoMetadata.Data.UserInfos.Data.map((u: any) => u.User._userId.Data),
      camera: {
        FOV: photoMetadata.Data.CameraFOV.Data,
        model: photoMetadata.Data.CameraModel.Data,
        manufacturer: photoMetadata.Data.CameraManufacturer.Data,
      },
    };
    // TEMP: Direct file export test
    // const result = await fetch(outRecord.assetURL);
    // const path = `./dist/${outRecord.id}`;
    // await Bun.write(path, result);
    return outRecord;
  })
);
// #endregion

// #region Oxibooru API Token
const oxibooruToken = Buffer.from(
  `${process.env.oxibooruUser}:${process.env.oxibooruToken}`
).toString('base64');
const oxibooruHost = process.env.oxibooruInstance!.split('//')[1];
if (!oxibooruHost) throw new Error('Unable to parse oxibooruInstance in env');
const oxibooruHeaders = new Headers();
oxibooruHeaders.append('Authorization', `Token ${oxibooruToken}`);
oxibooruHeaders.append('Accept', 'application/json');
oxibooruHeaders.append('Content-Type', 'application/json');
oxibooruHeaders.append('Host', oxibooruHost);

const oxibooruFunctions: oxibooruFunctionTypes = {
  uploadPost: { method: HTTPMethodOxibooru.post, endpoint: 'uploads/' },
  validatePost: { method: HTTPMethodOxibooru.post, endpoint: 'posts/reverse-search/' },
  createPost: { method: HTTPMethodOxibooru.post, endpoint: 'posts/' },
  searchPosts: { method: HTTPMethodOxibooru.get, endpoint: 'posts/' },
  updatePost: { method: HTTPMethodOxibooru.put, endpoint: 'post/' },
  getTagCategories: { method: HTTPMethodOxibooru.get, endpoint: 'tag-categories/' },
  createTagCategory: { method: HTTPMethodOxibooru.post, endpoint: 'tag-categories/' },
  updateTagCategory: { method: HTTPMethodOxibooru.put, endpoint: 'tag-category/' },
  searchTags: { method: HTTPMethodOxibooru.get, endpoint: 'tags/' },
  getTag: { method: HTTPMethodOxibooru.get, endpoint: 'tag/' },
  updateTag: { method: HTTPMethodOxibooru.put, endpoint: 'tag/' },
  deleteTag: { method: HTTPMethodOxibooru.delete, endpoint: 'tag/' },
} as const;

async function oxibooru(
  fn: (typeof oxibooruFunctions)[keyof typeof oxibooruFunctions],
  args: string | undefined = '',
  body: object | undefined
) {
  const outRaw = await fetch(`${process.env.oxibooruInstance}/api/${fn.endpoint}${args}`, {
    method: fn.method,
    body: body ? JSON.stringify(body) : undefined,
    headers: oxibooruHeaders,
  });
  if (!outRaw.ok) {
    console.warn(fn.endpoint, outRaw.statusText, await outRaw.text(), { args, body });
    return null;
  }
  const output = await outRaw.json();
  return output;
}
// #endregion

// #region Update categories
if (config.oxibooru.useCategories) {
  const configTagCategories = Object.entries(config.oxibooru.categories).map((e) => e[1]);
  const currentTagCategories = (await oxibooru(
    oxibooruFunctions.getTagCategories!,
    undefined,
    undefined
  )) as getTagCategoriesResponse;
  await configTagCategories.forEach(async (configCategoryName, i) => {
    // check, if category was created
    const foundEntry = currentTagCategories.results.find(
      (category) => category.name === configCategoryName
    );
    if (!foundEntry) {
      const output = await oxibooru(oxibooruFunctions.createTagCategory!, undefined, {
        name: configCategoryName,
        color: 'default',
        order: i,
      });
      if (!output) throw new Error("Couldn't create a category.");
      return;
    }
  });
}
// #endregion

// #region Create Posts
// if successful, send delete request for the image to resonite
async function deleteResoniteRecord(record: resoniteInventoryRecord, i: number) {
  console.log(i, record.photoMetadata.location.name);
  if (!config.oxibooru.deleteSourcePictures) return;
  await fetch(`https://api.resonite.com/users/${tokenBody.entity.userId}/records/${record.id}`, {
    method: HTTPMethodOxibooru.delete,
    headers: { Authorization },
  });
}

// clear out nulled records.
const assetRecordsClean = assetRecords.filter((out) => out !== null);

await assetRecordsClean.forEach(async (record, i) => {
  // upload file
  const contentToken = (await oxibooru(oxibooruFunctions.uploadPost!, undefined, {
    contentUrl: record.assetURL,
  })) as uploadPostResponse;
  if (!contentToken) return console.warn('Issue with uploading ', record.assetURL);
  const validatePostResp = (await oxibooru(oxibooruFunctions.validatePost!, undefined, {
    contentToken: contentToken.token,
  })) as validatePostResponse;
  if (validatePostResp.exactPost !== null) return deleteResoniteRecord(record, i);

  // sanitize default tags
  const defaultTags = record.tags.map((tag) => tag.replace(/<[^>]+>/g, ''));
  [
    record.photoMetadata.location.name.toLowerCase(),
    defaultTags.find((tag) => tag.startsWith('texture_asset')) || '',
    defaultTags.find((tag) => tag.startsWith('timestamp')) || '',
    defaultTags.find((tag) => tag.startsWith('location_accesslevel')) || '',
    defaultTags.find((tag) => tag.startsWith('location_hiddenfromlisting')) || '',
    defaultTags.find((tag) => tag.startsWith('location_host')) || '',
    defaultTags.find((tag) => tag.startsWith('location_name')) || '',
    'in',
  ].forEach((removeTag) => {
    const removeIndex = defaultTags.indexOf(removeTag);
    if (removeIndex !== -1) defaultTags.splice(removeIndex, 1);
  });

  // get all data and put into array for tags
  const tags = [
    ...defaultTags,
    ...record.photoMetadata.userIds,
    `savedBy:${record.ownerId}`,
    record.photoMetadata.location.name,
    `sessionName:${record.photoMetadata.location.name}`,
    `host:${record.photoMetadata.location.host}`,
    record.photoMetadata.location.accessLevel,
    `accessLevel:${record.photoMetadata.location.accessLevel}`,
    record.photoMetadata.location.hiddenFromListing ? 'hiddenSession' : null,
    `takenBy:${record.photoMetadata.takenBy}`,
    record.photoMetadata.timeTaken.toISOString().split('T')[0],
    appVersion,
    record.photoMetadata.appVersion,
    // check if modded app-version is set
    record.photoMetadata.appVersion.includes('+')
      ? record.photoMetadata.appVersion.split('+')[0]!
      : null,
  ]
    .filter((tag) => tag)
    .map((tag) => tag?.replaceAll(' ', '_'));

  // get safety level
  let safety: safetyLevels = 'safe';
  // order is important
  if (record.photoMetadata.location.accessLevel === 'FriendsOfFriends') safety = 'sketchy';
  if (record.photoMetadata.location.accessLevel === 'Contacts') safety = 'unsafe';
  if (record.photoMetadata.location.accessLevel === 'Private') safety = 'unsafe';
  if (record.photoMetadata.location.hiddenFromListing === true) safety = 'unsafe';

  // create post from tags
  const post = await oxibooru(oxibooruFunctions.createPost!, undefined, {
    // new Set deduplicated tags
    tags: [...new Set(tags)],
    contentToken: contentToken.token,
    source: record.assetURL,
    safety,
  });
  // delete resonite image if picture was added successfully
  if (post) deleteResoniteRecord(record, i);
});
// #endregion

// #region Update tag category
if (!config.oxibooru.useCategories) process.exit();
const sortedTags = {
  // TODO: POC! Has to be made the default and then broken down again on post-creation. not the other way around.
  users: await assetRecordsClean.flatMap((record) => record.photoMetadata.userIds),
  host: await assetRecordsClean.flatMap((record) => `host:${record.photoMetadata.location.host}`),
  accessLevel: await assetRecordsClean.flatMap((record) => [
    `accessLevel:${record.photoMetadata.location.accessLevel}`,
    record.photoMetadata.location.accessLevel,
  ]),
  savedBy: await assetRecordsClean.flatMap((record) => `savedBy:${record.ownerId}`),
  takenBy: await assetRecordsClean.flatMap((record) => `takenBy:${record.photoMetadata.takenBy}`),
  sessionName: await assetRecordsClean.flatMap((record) => [
    `sessionName:${record.photoMetadata.location.name}`,
    record.photoMetadata.location.name,
  ]),
  hidden: ['hiddenSession'],
  dateTaken: await assetRecordsClean.flatMap(
    (record) => record.photoMetadata.timeTaken.toISOString().split('T')[0]
  ),
  importerVersion: [appVersion],
  gameVersion: await assetRecordsClean.flatMap((record) => [
    record.photoMetadata.appVersion,
    // check if modded app-version is set
    record.photoMetadata.appVersion.includes('+')
      ? record.photoMetadata.appVersion.split('+')[0]!
      : null,
  ]),
};
const isCategorySet = (categoryName: string) =>
  Object.keys(config.oxibooru.categories).find((configName) => configName === categoryName);

const categories = config.oxibooru.categories;
// FIXME: want to use typeof categories, but im stoopid
function updateCategoryTags(tags: string[] | userId[], category: string) {
  new Set(tags).forEach(async (tag) => {
    const sanitizedTag = tag?.replaceAll(' ', '_');
    const foundTag = (await oxibooru(
      oxibooruFunctions.getTag!,
      sanitizedTag,
      undefined
    )) as getTagResponse;
    if (!foundTag) return console.warn(`Unable to find tag ${sanitizedTag} to update category.`);
    if (foundTag.category === category) return;
    oxibooru(oxibooruFunctions.updateTag!, sanitizedTag, { category, version: foundTag.version });
  });
}

if (isCategorySet('users')) updateCategoryTags(sortedTags.users, categories.users);
if (isCategorySet('host')) updateCategoryTags(sortedTags.host, categories.host);
if (isCategorySet('accessLevel'))
  updateCategoryTags(sortedTags.accessLevel, categories.accessLevel);
if (isCategorySet('savedBy')) updateCategoryTags(sortedTags.savedBy, categories.savedBy);
if (isCategorySet('sessionName'))
  updateCategoryTags(sortedTags.sessionName, categories.sessionName);
if (isCategorySet('hidden')) updateCategoryTags(sortedTags.hidden, categories.hidden);
if (isCategorySet('takenBy')) updateCategoryTags(sortedTags.takenBy, categories.takenBy);
if (isCategorySet('dateTaken'))
  updateCategoryTags(
    sortedTags.dateTaken.filter((e) => e !== undefined),
    categories.dateTaken
  );
if (isCategorySet('importerVersion'))
  updateCategoryTags(sortedTags.importerVersion, categories.importerVersion);
if (isCategorySet('gameVersion'))
  updateCategoryTags(
    sortedTags.gameVersion.filter((e) => e !== null),
    categories.gameVersion
  );
// #endregion

// #region Legacy migrations
// This is a hack! Only needed to cleanup previous posts and will be deleted after.
if (!config.oxibooru.useLegacyMigrations) process.exit();
if (!config.oxibooru.useCategories) console.warn("useCategories has to be true for migrating tags to categories.");

// update legacy timestamps
const legacyTimestamps = await oxibooru(oxibooruFunctions.searchTags!, `?${new URLSearchParams({ query:'timestamp\\:*', limit: '200', fields: 'names,version' })}`, undefined) as getTagSearchResponse;
if (legacyTimestamps && legacyTimestamps.results) {
  legacyTimestamps.results.forEach(async (timestamp) => {
    const date = timestamp.names[0]?.replace('timestamp:', '').split('T')[0];
    if (!date) return;
    const oldTimestamp = timestamp.names[0]?.replaceAll(':', '\\:').replaceAll('.', '\\.');
    const posts = await oxibooru(oxibooruFunctions.searchPosts!, `?${new URLSearchParams({ query: `${oldTimestamp}`, limit: '200', fields: 'version,id,tags' })}`, undefined) as getPostSearchResponse;
    if (posts && posts.results) {
      posts.results.forEach(async (post) => {
        const tags = post.tags?.map((tag) => tag.names[0]);
        if (!tags) return;
        const successfulUpdate = await oxibooru(oxibooruFunctions.updatePost!, `${post.id}`, { tags: [...tags, date], version: post.version })
        if (!successfulUpdate) return;
        await oxibooru(oxibooruFunctions.deleteTag!, timestamp.names[0], { version: timestamp.version })
      })
    }
  });
}

// remove texture_asset tags
const textureAssetTags = await oxibooru(oxibooruFunctions.searchTags!, `?${new URLSearchParams({ query:'texture_asset\\*', limit: '200', fields: 'names,version' })}`, undefined) as getTagSearchResponse;
if (textureAssetTags && textureAssetTags.results) textureAssetTags.results.forEach((tag) => {
  oxibooru(oxibooruFunctions.deleteTag!, encodeURIComponent(tag.names[0]!), { version: tag.version })
});

// all migrations below require the category feature to be enabled.
if (!config.oxibooru.useCategories) process.exit();

// update legacy user categories
const legacyUsers = await oxibooru(oxibooruFunctions.searchTags!, `?${new URLSearchParams({ query:'U-* -category:User', limit: '200', fields: 'names' })}`, undefined) as getTagSearchResponse;
if (legacyUsers && legacyUsers.results) updateCategoryTags(legacyUsers.results.map((tag) => tag.names[0]).filter((e) => e !== undefined), categories.users);

// update date and game version categories
for (let i = 0; i < 3; i++) {
  const dates = await oxibooru(oxibooruFunctions.searchTags!, `?${new URLSearchParams({ query:`${new Date().getFullYear() - i}-*-*`, limit: '200', fields: 'names' })}`, undefined) as getTagSearchResponse;
  if (dates && dates.results) updateCategoryTags(dates.results.map((tag) => tag.names[0]).filter((e) => e !== undefined), categories.dateTaken);
  const gameVersions = await oxibooru(oxibooruFunctions.searchTags!, `?${new URLSearchParams({ query:`${new Date().getFullYear() - i}.*.*.*`, limit: '200', fields: 'names' })}`, undefined) as getTagSearchResponse;
  if (gameVersions && gameVersions.results) updateCategoryTags(gameVersions.results.map((tag) => tag.names[0]).filter((e) => e !== undefined), categories.gameVersion);
}
// #endregion
