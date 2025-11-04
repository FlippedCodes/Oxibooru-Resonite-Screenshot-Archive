# Oxibooru Resonite Screenshot Archive

A tool to archive Screenshots from your Resonite Inventory to [Oxibooru](https://github.com/liamw1/oxibooru).

Froox Example             |  Phil Example
:-------------------------:|:-------------------------:
![Froox Light](./assets/froox_light.png#gh-light-mode-only) ![Froox Dark](./assets/froox_dark.png#gh-dark-mode-only)  |  ![Phil Light](./assets/phil_light.png#gh-light-mode-only) ![Phil Dark](./assets/phil_dark.png#gh-dark-mode-only)

> [!NOTE]
> UserIds have been stripped from the above screenshot.

## How to use

### Prerequisites

- A Resonite Account
- [Bun.sh](https://bun.com/)
  - Might need adjustment if you want to use [Node.js](https://nodejs.org/en) with [TS](https://www.typescriptlang.org/).
- A working instance of [Oxibooru](https://github.com/liamw1/oxibooru) ([Szurubooru](https://github.com/rr-/szurubooru) might work as well, but wasn't tested.)
  - [What is a Booru/Imageboard?](https://en.wikipedia.org/wiki/Imageboard#Booru)
  - Script can be modified, if you only want to have a file export or use a different software.

### Install

> [!NOTE]
> If you plan on working on the script you should install it with dev-dependencies: `bun install`

1. Install the required dependencies with `bun install --production`.
1. Rename `dist.env` to `.env`
1. Add logins and tokens to `.env`
1. Adjust `photoLocation` in `config.json` file

> [!WARNING]
> `deleteSourcePictures` should only be set to `true`, if you are sure all screenshots have been exported.

### Usage

You can run the script by running `bun start`.

When you made sure it ran smoothly and all pictures are in the booru, you can re-run it with `deleteSourcePictures` set to `true`.

> [!NOTE]
> The script will skip screenshots that are already added.

## Honorable mentions

This project was inspired by [yoshs' bash implementation](https://git.unix.dog/yosh/misc-scripts/src/branch/master/resonite-photoexif) and a great help to deal with Resonite's bson implementation. Also thankies goes out to JayKub for helping otu with coding. ~~I'm new to typescript!. Please don't hurt meeee!~~

## Why

Resonite inventory records have more metadata, then Steam-Screenshots or File-Exports. This allows for extra information, like session names, attendees, camera settings and camera man. All this info can be used nicely inside an Imageboard, like Oxibooru.

## Limitations

We can only do as much as Data provides. One major downside to this is, that the default Resonite cameras include all the users that are in a session. This makes it still somewhat hard to browse for pictures about yourself - cause you are in every session, when you take the pictures.
Maybe there will be a camera one day that only adds the users that are in a picture.

## Design Choices

### Split Design

The script is intentionally split in two parts to make tit easy to fork this project and use your own self-hosted booru or export to some file-format - without the need to reinvent the wheel.

### No npm package?

First and foremost this script was created for me, myself and I, to fit my weird requirements and power-user needs. If there is any interest by users we can make the resonite api parts into a package. But as it stands right now, there is no interest on my end yet.

### No Resonite multiple and nested folder support

I decided to scrap the idea of importing multiple and nested folders. All pictures are tagged with all the information already.

### A Booru as storage

It was considered to maybe run [Immich](https://immich.app/), but that is more useful for IRL pictures.
I use both for other projects felt a booru is the best way to store pictures like this, because Since there is a lot of information the screenshots can be sorted by.

## ToDo-List

- [x] Support for oxibooru categories
- [x] Remove tags, that are only used once
  - Limit Timestamp to Hours
  - texture_asset
- [ ] Get usernames from Resonite API and add as tags
- [ ] Split code into modular system to support more export methods
- [ ] Support for oxibooru pools and group events together some way.
- [ ] Support for saved image-grabbers/slurpers
- [ ] Consolidate tags in Oxibooru
  - UserIds with usernames
  - session with and without prefix
- [ ] Make "safety"-level more configurable
- [ ] Add exported data to Oxibooru's description field.
