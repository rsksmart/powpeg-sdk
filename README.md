[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/rsksmart/powpeg-sdk/badge)](https://scorecard.dev/viewer/?uri=github.com/rsksmart/powpeg-sdk)
[![CodeQL](https://github.com/rsksmart/powpeg-sdk/workflows/CodeQL/badge.svg)](https://github.com/rsksmart/powpeg-sdk/actions?query=workflow%3ACodeQL)

# powpeg-sdk
SDK for creating native peg-in and peg-out transactions following the PowPeg protocol.

# How to publish a beta package?

* Update `package.json` `version` field to the format `<version>-beta.<i++>` (eg: 1.0.1-beta.0).
* Create tag matching the `version` field.
* Push pre-release for the github package.

# How to publish a package?

* Update `package.json` `version` field to the format `<version>` (eg: 1.0.1).
* Create tag matching the `version` field.
* Publish the github package.
