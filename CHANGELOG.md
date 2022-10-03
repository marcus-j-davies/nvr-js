# NVR-JS Change Log

  - 3.0.0 

    **Breaking Changes**
     - The **NVRJS_CAMERA_RECORDINGS** directory is no longer used.
     - The Storage mechanism has been updated, and is not compatible with previous recordings
        - You can continue to run this version with no issues, but previous data will not be available.
     - Event payload properties have been updated.
        - **name** -> **event**
        - **date** -> **timestamp**

    **New Features**
     - Raise an event whilst reviewing live footage
     - Each recorded segement, now contains a hash, this offers the ability to check for modifications of recorded footage (SHA256).
     - Allow post input configuration This allows to convert a stream that may not natively be h264
     - Ability to disable security, allowing 3rd party access control.

    **Changes**
     - Dependency updates.
     - SQL storage has been removed and replaced with JSON files
     - Performancee updates


  - 2.0.0

    **Breaking Changes**
     - NVR system folders have been renamed. rename them to continue with your current data.
       - system  -> NVRJS_SYSTEM  
       - cameras -> NVRJS_CAMERA_RECORDINGS
     - API Access no longer uses the UI password, it uses its own API key, as configured in the config file.  
       Add a new value named **apiKey** in the **system** section - this should be a bcript value of your chosen API key
     - Username is now requied in the login page.  
       Add a new value named **username** in the **system** section to set it - this should be plain text  
     - API is now accessed via the /api/ URI

    **Changes**
     - Dependency updates.
     - Clean/polish up the UI.
     - Re-worked ffmpeg stream pipes.
     - SQL data writes are now queued.
     - Rate Limiting is now applied to the the HTTP application.

    **New Features**
     - New API functions (URI's)
       - **/systeminfo**  
       - **/cameras**  
       - **/snapshot/:CameraID/:Width**  
       - **/geteventdata/:CameraID/:Start/:End**  

  - 1.0.2

    **Fixes**
     - Fix directory creation

  - 1.0.1

    **Fixes**
     - Correct drive space usage query.

  - 1.0.0

    **Initial Release**



