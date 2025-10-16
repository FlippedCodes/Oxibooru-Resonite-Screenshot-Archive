type userId = `U-${string}`;

export type safetyLevels = 'safe' | 'sketchy' | 'unsafe'

type location = {
  name: string;
  host: string;
  accessLevel: 'Anyone' | 'RegisteredUsers' | 'FriendsOfFriends' | 'Private';
  hiddenFromListing: boolean;
};

type camera = {
  FOV: number;
  manufacturer: string;
  model: string;
};

export enum HTTPMethodOxibooru {
  get = 'GET',
  post = 'POST',
  delete = 'DELETE',
  put = 'PUT',
}

export type oxibooruFunctionTypes = {
  [key: string]: {
    method: HTTPMethodOxibooru;
    endpoint: string;
  };
};

export type tokenBody = {
  entity: {
    userId: string;
    token: string;
  };
};

export type uploadPostResponse = {
  token: string;
};

export type validatePostResponse = {
  exactPost: null | string;
  similarPosts: string[];
};

export type resoniteInventoryRecord = {
  id: string;
  name: `Photo in ${string}`;
  tags: string[];
  assetUri?: string;
  recordId: string;
  imageURL: string;
  assetURL: string;
  recordType: 'object';
  ownerId: string;
  photoMetadata: {
    location: location;
    timeTaken: Date;
    takenBy: userId;
    appVersion: `${number}.${number}.${number}.${number}${`+${string}` | ''}`;
    userIds: userId[];
    camera: camera;
  };
};
