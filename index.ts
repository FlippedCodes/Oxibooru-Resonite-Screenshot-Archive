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
} from './types';

import { HTTPMethodOxibooru } from './types';

import config from './config.json';

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
    console.debug(fn.endpoint, outRaw.statusText, await outRaw.text());
    return null;
  }
  const output = await outRaw.json();
  return output;
}
// #endregion

// if successful, send delete request for the image to resonite
async function deleteResoniteRecord(record: resoniteInventoryRecord, i: number) {
  console.log(i, record.photoMetadata.location.name);
  if (!config.oxibooru.deleteSourcePictures) return;
  await fetch(`https://api.resonite.com/users/${tokenBody.entity.userId}/records/${record.id}`, {
    method: HTTPMethodOxibooru.delete,
    headers: { Authorization },
  });
}

// #region Create Posts
await assetRecords
  // clear out nulled records.
  .filter((out) => out !== null)
  .forEach(async (record, i) => {
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
      record.ownerId,
      `savedBy:${record.ownerId}`,
      record.photoMetadata.location.name,
      `sessionName:${record.photoMetadata.location.name}`,
      record.photoMetadata.location.host,
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
    if (post) return deleteResoniteRecord(record, i);
  });
// #endregion
