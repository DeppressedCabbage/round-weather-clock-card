# round-weather-clock-card
A round Weather and Clock Lovelace Card for home assistant. 

A custom Lovelace card which renders in a circle, and showcases the 5 day forecast, with today’s forecast being the ring around the outside of the display.
It works like a clock, if the clock was only a partial arc. Noon is at the very top, 12AM on the left side and 11:59PM on the Right. Gives a good enough estimate of when the high and low for the day will be. 
When clicking on the actual clock, it renders as set of On/Off switches (Configurable on the UI, up to 4, limited to Lights, Fans, Switches, and Toggles). There is a 20 second timeout on the secondary view to automatically return the dash to the forecast. 

The entire card was built to suit a Rooted Amazon Echo Spot from 2017, and automatically scales to fit the display. As such, it may not render properly if any other cards are being used on the dashboard. It is still a work in progress and if enough people want it to work standalone I may change it up. 

----
Configuration Options

<img width="505" height="1045" alt="image" src="https://github.com/user-attachments/assets/ec08b73e-045e-44b9-8258-a4816ad729ec" />
----
Default Forecast View
<img width="1399" height="1159" alt="image" src="https://github.com/user-attachments/assets/e4b30994-050b-4823-86ce-9bb988828055" />
----
Secondary Switch Options
<img width="1349" height="1166" alt="image" src="https://github.com/user-attachments/assets/0187e204-c3a2-446f-9c42-9e304cc7eeb6" />

