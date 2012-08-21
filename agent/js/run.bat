@echo off
set SERVER=http://localhost:8888
set LOCATION=Test
set PROJECT_ROOT=%~dp0

:FINDPROJECTROOT
if not exist webpagetest\agent\js goto NOTFOUNDPROJECTROOT
goto FOUNDPROJECTROOT

:NOTFOUNDPROJECTROOT
cd ..
if %CD%==%CD:~0,3% goto :PROJECTROOTERROR
goto :FINDPROJECTROOT

:PROJECTROOTERROR
echo Couldn't find project root
cd %~dp0
goto :eof

:FOUNDPROJECTROOT
echo Project Root: %CD%
set PROJECT_ROOT=%CD%
cd %~dp0

set AGENT=%PROJECT_ROOT%\webpagetest\agent\js
set DEVTOOLS2HAR_JAR=%PROJECT_ROOT%\webpagetest\lib\dt2har\target\dt2har-1.0-SNAPSHOT-jar-with-dependencies.jar
set SELENIUM_BUILD=%project_root%\Selenium\selenium-read-only\build
set NODE_PATH="%AGENT%;%AGENT%\src;%SELENIUM_BUILD%\javascript\webdriver

node src\agent_main --wpt_server %SERVER% --location %LOCATION% --chromedriver %SELENIUM_BUILD%\chromedriver --selenium_jar %SELENIUM_BUILD%\java\server\src\org\openqa\grid\selenium\selenium-standalone.jar --devtools2har_jar=%DEVTOOLS2HAR_JAR%
